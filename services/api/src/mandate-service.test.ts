import { describe, expect, it, vi } from 'vitest';
import { type MandateAuthorityIntent, type MandateDecisionIntent, type MandateOperationResult, type MemberCandidate } from '@pactwoven/contracts';
import { type MandateRepository, type MandateVerificationRequest, type VerifiedIdentity, type VerifiedMandateStepUpIdentity } from '@pactwoven/db';
import { commandDigest, DomainError, mandateIntentHash } from '@pactwoven/domain';
import { createMandateGateway } from './mandate-service.js';
import { createApp } from './app.js';

const identity: VerifiedIdentity = { subject: 'finance_a', externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Test',
  externalMembershipId: 'member_finance', externalRole: 'org:member', sessionId: 'session_finance', membershipObservedAt: new Date().toISOString(), authenticatedAt: new Date().toISOString() };
const candidate: MemberCandidate = { externalOrganizationId: 'clerk_org_a', externalMembershipId: 'member_operations', externalSubject: 'operations_a', externalRole: 'org:member', displayName: 'Operations', observedAt: new Date().toISOString() };
const decision: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: { id: 'proposal_a', version: 1, hash: 'a'.repeat(64) }, expectedDecisionVersion: 1, expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
const control: MandateAuthorityIntent = { schemaVersion: 1, action: 'RESUME', mandate: { id: 'mandate_a', version: 1, hash: 'a'.repeat(64) }, head: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 2, hash: 'b'.repeat(64) },
  responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a', hash: 'c'.repeat(64) }, expectedOrganizationEpoch: 2, reason: 'Resume reviewed authority' };
const result: MandateOperationResult = { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a', kind: 'mandate.authorize', target: { kind: 'decision', id: 'proposal_a', version: 2, hash: 'd'.repeat(64) },
  commandHash: 'e'.repeat(64), intentHash: 'f'.repeat(64), observedAt: new Date().toISOString(), operation: { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: 'proposal_a', aggregateVersion: 2, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
const key = 'mandate_request_key_0001';
function fixture(requestNonce?: string) {
  const events: string[] = [];
  const repository: MandateRepository = { readDocument: vi.fn(), list: vi.fn(), review: vi.fn(), operation: vi.fn(async () => { events.push('recover'); return result; }),
    requester: vi.fn(async () => { events.push('requester'); return { externalSubject: 'operations_a', externalMembershipId: 'member_operations' }; }),
    mutate: vi.fn(async () => { events.push('mutate'); return result; }) };
  const verifyIdentity = vi.fn(async () => { events.push('identity'); return { ...identity }; });
  const directory = { resolve: vi.fn(async () => { events.push('directory'); return { ...candidate }; }) };
  const verifyMandateStepUp = vi.fn(async (_token: string, request: MandateVerificationRequest): Promise<VerifiedMandateStepUpIdentity> => {
    events.push('step-up'); const issued = Math.floor(Date.now() / 1000) * 1000, purpose = request.intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
    return { identity: { ...identity }, evidence: { id: crypto.randomUUID(), purpose, subject: identity.subject, externalOrganizationId: identity.externalOrganizationId,
      externalMembershipId: identity.externalMembershipId, sessionId: identity.sessionId, issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64),
      tokenIssuedAt: new Date(issued).toISOString(), firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, verifiedAt: new Date(issued - 60_000).toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(issued + 180_000).toISOString(),
      intentHash: await mandateIntentHash(request.intent), requestNonce: request.nonce, requestHash: await commandDigest({ schemaVersion: 1, purpose, request }) } };
  });
  const gateway = createMandateGateway({ repository, verifyIdentity, directory, verifyMandateStepUp, ...(requestNonce ? { requestNonce } : {}) });
  return { repository, verifyIdentity, verifyMandateStepUp, directory, gateway, events };
}
describe('private mandate gateway', () => {
  it('verifies current requester before purpose-specific authorization and binds the original token, key and nonce', async () => {
    const nonce = crypto.randomUUID(), f = fixture(nonce);
    expect(await f.gateway.decide('original-token', 'responsibility_a', 'proposal_a', key, decision, 'trace')).toEqual(result);
    expect(f.events).toEqual(['identity', 'requester', 'directory', 'step-up', 'mutate']);
    expect(f.verifyMandateStepUp).toHaveBeenCalledWith('original-token', { nonce, key, intent: decision });
    expect(f.repository.mutate).toHaveBeenCalledWith(expect.objectContaining({ identity, requestNonce: nonce, requesterObservation: candidate }), 'responsibility_a', key, { kind: 'decide', proposalId: 'proposal_a', intent: decision }, 'trace');
  });
  it('generates a fresh nonce for each direct invocation', async () => {
    const f = fixture();
    await f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, decision, 'trace');
    await f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, decision, 'trace');
    expect(f.verifyMandateStepUp.mock.calls[0]![1].nonce).not.toBe(f.verifyMandateStepUp.mock.calls[1]![1].nonce);
  });
  it('uses the accepted version requester and dedicated control purpose for resume', async () => {
    const f = fixture(); await f.gateway.control('token', 'responsibility_a', 'mandate_a', key, control, 'trace');
    expect(f.repository.requester).toHaveBeenCalledWith(identity, 'responsibility_a', { kind: 'mandate', reference: control.mandate }, 'trace');
    expect(f.verifyMandateStepUp.mock.calls[0]![1].intent.action).toBe('RESUME');
  });
  it.each(['PAUSE', 'REVOKE'] as const)('applies %s immediately without requester lookup or MFA', async action => {
    const f = fixture(); await f.gateway.control('token', 'responsibility_a', 'mandate_a', key, { ...control, action }, 'trace');
    expect(f.events).toEqual(['identity', 'mutate']); expect(f.directory.resolve).not.toHaveBeenCalled(); expect(f.verifyMandateStepUp).not.toHaveBeenCalled();
    expect(vi.mocked(f.repository.mutate).mock.calls[0]![0]).toMatchObject({ evidence: null, requesterObservation: null });
  });
  it('rechecks identity after requester lookup for rejection without fabricating MFA', async () => {
    const f = fixture(); await f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, { ...decision, action: 'REJECT', reason: 'Policy needs revision' }, 'trace');
    expect(f.events).toEqual(['identity', 'requester', 'directory', 'identity', 'mutate']); expect(f.verifyMandateStepUp).not.toHaveBeenCalled();
  });
  it('recovers committed operations with only current identity and no new MFA', async () => {
    const f = fixture(); f.verifyMandateStepUp.mockRejectedValue(new DomainError('STEP_UP_REQUIRED', 403, 'Expired'));
    expect(await f.gateway.operation('token', { kind: 'mandate.authorize', key }, 'trace')).toEqual(result);
    expect(f.events).toEqual(['identity', 'recover']); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['subject', 'externalOrganizationId', 'externalMembershipId', 'sessionId', 'externalRole'] as const)('rejects identity %s drift between preflight and MFA', async field => {
    const f = fixture(), original = f.verifyMandateStepUp.getMockImplementation()!;
    f.verifyMandateStepUp.mockImplementation(async (token, request) => { const verified = await original(token, request); verified.identity[field] = 'changed_pin'; return verified; });
    await expect(f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, decision, 'trace')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['externalSubject', 'externalMembershipId', 'externalOrganizationId'] as const)('rejects requester %s substitution', async field => {
    const f = fixture(); f.directory.resolve.mockResolvedValue({ ...candidate, [field]: 'foreign_pin' });
    await expect(f.gateway.control('token', 'responsibility_a', 'mandate_a', key, control, 'trace')).rejects.toMatchObject({ code: 'REQUESTER_CHANGED' });
    expect(f.verifyMandateStepUp).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('snapshots the command before provider awaits so caller mutation cannot change the authorized effect', async () => {
    const f = fixture(), input = structuredClone(decision);
    f.directory.resolve.mockImplementation(async () => { input.proposal.id = 'foreign_proposal'; input.expectedOrganizationEpoch = 500; return candidate; });
    await f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, input, 'trace');
    expect(f.verifyMandateStepUp.mock.calls[0]![1].intent).toEqual(decision);
    expect(vi.mocked(f.repository.mutate).mock.calls[0]![3]).toEqual({ kind: 'decide', proposalId: 'proposal_a', intent: decision });
  });
  it('rejects route mismatch and public proof fields before any provider call', async () => {
    const f = fixture();
    await expect(f.gateway.decide('token', 'responsibility_a', 'wrong_proposal', key, decision, 'trace')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(f.gateway.control('token', 'responsibility_a', 'wrong_mandate', key, control, 'trace')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, { ...decision, evidence: {} } as MandateDecisionIntent, 'trace')).rejects.toBeDefined();
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it('stops all effects on requester lookup or provider failure', async () => {
    const f = fixture(); vi.mocked(f.repository.requester).mockRejectedValueOnce(new DomainError('FORBIDDEN', 403, 'Denied'));
    await expect(f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, decision, 'trace')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.directory.resolve).not.toHaveBeenCalled();
    f.verifyMandateStepUp.mockRejectedValueOnce(new DomainError('STEP_UP_REQUIRED', 403, 'Fresh proof required'));
    await expect(f.gateway.decide('token', 'responsibility_a', 'proposal_a', key, decision, 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('rejects duplicate read fields and mutation queries consistently in direct Node routes', async () => {
    const f = fixture(), app = createApp({ allowedOrigins: ['http://localhost:3001'], verifyIdentity: f.verifyIdentity, mandateGateway: f.gateway });
    const headers = { Authorization: 'Bearer original-token', Origin: 'http://localhost:3001', 'Content-Type': 'application/json', 'Idempotency-Key': key };
    for (const path of ['/v1/responsibilities/responsibility_a/mandates?limit=1&limit=2', '/v1/responsibilities/responsibility_a/mandates/proposal_a?version=1&version=2', `/v1/mandate-operations?kind=mandate.authorize&kind=mandate.reject&key=${key}`]) {
      expect((await app.request(path, { headers })).status).toBe(422);
    }
    expect((await app.request('/v1/responsibilities/responsibility_a/mandate-proposals/proposal_a/decision?unexpected=1', { method: 'POST', headers, body: JSON.stringify(decision) })).status).toBe(422);
    expect(f.repository.mutate).not.toHaveBeenCalled(); expect(f.repository.operation).not.toHaveBeenCalled();
    const response = await app.request(`/v1/mandate-operations?kind=mandate.authorize&key=${key}`, { headers });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(await response.json()).toEqual(result);
  });
});
