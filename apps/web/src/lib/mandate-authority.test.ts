import { describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import type { MandateOperationResult, MandatePage } from '@pactwoven/contracts';
import { authorityAvailable, authorityDigests, createAuthorityCapsule, qualifyAuthorityOperation, qualifyAuthorityReceipt, verifyAuthorityCapsule, type MandateStopAction } from './mandate-authority';
import { locatorFromAuthorityCapsule } from './mandate-authority-recovery';
import { mandateReadFixture, mandateFixtureNow as now } from './mandates.test-fixtures';
async function fixture(action: MandateStopAction = 'PAUSE') {
  const f = await mandateReadFixture();
  f.page.head!.mandateEpoch = 7; f.review.envelope.head!.mandateEpoch = 7;
  f.page.eligibility = [{ action, eligible: true, requiresStepUp: false, blockers: [] }]; f.review.envelope.eligibility = f.page.eligibility;
  const observation = { data: f.page, receivedAt: now, receivedMonotonic: 0 };
  const capsule = await createAuthorityCapsule(f.scope, observation, action, '  Stop new use.\nKeep existing obligations.  ', 'authority_request_123456', now), locator = locatorFromAuthorityCapsule(capsule);
  const result: MandateOperationResult = { schemaVersion: 1, organizationId: f.scope.organizationId, kind: locator.kind, responsibilityId: f.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(now + 1000).toISOString(), operation: { id: 'authority_operation', environment: f.scope.environment, status: 'succeeded', aggregateId: locator.mandate.id, aggregateVersion: 8, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
  return { ...f, observation, capsule, locator, result };
}
describe('exact accepted authority stop preparation and receipts', () => {
  it.each(['PAUSE', 'REVOKE'] as const)('changes only head state and epoch for %s while preserving accepted version and terms', async action => {
    const f = await fixture(action), { capsule: c } = f;
    expect(c.nextHead).toEqual({ ...f.page.head, state: action === 'PAUSE' ? 'PAUSED' : 'REVOKED', mandateEpoch: 8 }); expect(c.intent.mandate).toEqual(f.page.acceptedVersion); expect(c.intent.head.mandateVersion).toBe(2); expect(c.expectedTarget.version).toBe(8); expect(c.expectedTarget.hash).toBe(await commandDigest(c.nextHead));
    expect(c.intent.reason).toBe('Stop new use.\nKeep existing obligations.'); expect(Object.isFrozen(c.intent)).toBe(true); expect(await verifyAuthorityCapsule(c)).toEqual(c);
  });
  it('uses current accepted authority from a qualified review even when the selected proposal is historical', async () => {
    const f = await fixture(), c = await createAuthorityCapsule(f.scope, { ...f.observation, data: f.review }, 'PAUSE', 'Review current accepted authority', 'authority_other_request', now);
    expect(f.review.envelope.proposal!.id).not.toBe(f.review.envelope.acceptedProposal!.id); expect(c.intent.mandate).toEqual(f.page.acceptedVersion); expect(c.intent.responsibility).toEqual(f.page.responsibilityReference); expect(c.intent.head.mandateEpoch).toBe(7);
  });
  it('permits an eligible stop with stale accepted org/responsibility basis without rebasing the accepted head', async () => {
    const f = await fixture(), scope = { ...f.scope, organizationEpoch: 4 }, responsibility = { ...f.page.responsibility, version: 3, title: 'Changed current terms' };
    const page: MandatePage = { ...f.page, organizationEpoch: 4, responsibility, responsibilityReference: { ...f.page.responsibilityReference, version: 3, hash: await commandDigest(responsibility) }, effectiveAuthority: { state: 'STALE', blockers: ['ORGANIZATION_CHANGED'] } };
    const c = await createAuthorityCapsule(scope, { ...f.observation, data: page }, 'PAUSE', 'Stop under current scope', 'authority_stale_request', now);
    expect(c.intent.expectedOrganizationEpoch).toBe(4); expect(c.intent.responsibility.version).toBe(3); expect(c.nextHead.organizationEpoch).toBe(3); expect(c.nextHead.policyHash).toBe(f.page.head!.policyHash); expect(c.intent.mandate).toEqual(f.page.acceptedVersion);
  });
  it('does not require requester independence, directory refresh or step-up for stops', async () => {
    const f = await fixture(), scope = { ...f.scope, actorId: f.acceptedSource.proposal.requesterId };
    expect(authorityAvailable(f.page, scope, 'PAUSE', now)).toBe(true); const c = await createAuthorityCapsule(scope, f.observation, 'PAUSE', 'Stop current use', 'requester_stop_request', now); expect(c.intent.action).toBe('PAUSE'); expect(Object.keys(c.intent)).toEqual(['schemaVersion', 'action', 'mandate', 'head', 'responsibility', 'expectedOrganizationEpoch', 'reason']);
  });
  it.each(['missing-head', 'service', 'role', 'read-site', 'action-site', 'org', 'foreign', 'expiry', 'stale', 'future', 'mfa', 'ineligible', 'paused', 'revoked', 'epoch-overflow'] as const)('rejects unavailable %s stop preparation', async change => {
    const f = await fixture(), scope = structuredClone(f.scope), page = structuredClone(f.page); let time = now;
    if (change === 'missing-head') { page.head = null; page.acceptedVersion = null; }
    if (change === 'service') scope.principalKind = 'service'; if (change === 'role') scope.roles = ['operations']; if (change === 'read-site') scope.siteIds = []; if (change === 'action-site') scope.actionSiteIds = [];
    if (change === 'org') scope.organizationEpoch++; if (change === 'foreign') scope.organizationId = 'other_org'; if (change === 'expiry') page.head!.expiresAt = new Date(now).toISOString(); if (change === 'stale') time += 60_000; if (change === 'future') time--;
    if (change === 'mfa') page.eligibility[0]!.requiresStepUp = true; if (change === 'ineligible') page.eligibility = []; if (change === 'paused') page.head!.state = 'PAUSED'; if (change === 'revoked') page.head!.state = 'REVOKED'; if (change === 'epoch-overflow') page.head!.mandateEpoch = 2_147_483_647;
    expect(authorityAvailable(page, scope, 'PAUSE', time)).toBe(false); await expect(createAuthorityCapsule(scope, { ...f.observation, data: page }, 'PAUSE', 'Stop current use', 'invalid_stop_request', time)).rejects.toThrow();
  });
  it('permits revoke from a paused head and the last representable resulting head epoch', async () => {
    const f = await fixture('REVOKE'), page = structuredClone(f.page); page.head!.state = 'PAUSED'; page.head!.mandateEpoch = 2_147_483_646; page.effectiveAuthority = { state: 'PAUSED', blockers: ['PAUSED'] };
    const c = await createAuthorityCapsule(f.scope, { ...f.observation, data: page }, 'REVOKE', 'End new use permanently', 'last_epoch_request', now); expect(c.expectedTarget.version).toBe(2_147_483_647);
  });
  it.each(['', ' ', 'x'.repeat(1001)])('rejects an invalid required reason', async reason => { const f = await fixture(); await expect(createAuthorityCapsule(f.scope, f.observation, 'PAUSE', reason, 'reason_request_key', now)).rejects.toThrow(); });
  it('rejects unsupported resume creation and forged current responsibility hashes', async () => {
    const f = await fixture(); await expect(createAuthorityCapsule(f.scope, f.observation, 'RESUME' as MandateStopAction, 'Resume', 'unsupported_request_key', now)).rejects.toThrow();
    const page = structuredClone(f.page); page.responsibilityReference.hash = 'a'.repeat(64); await expect(createAuthorityCapsule(f.scope, { ...f.observation, data: page }, 'PAUSE', 'Stop', 'bad_basis_request_key', now)).rejects.toThrow();
  });
  it.each(['reason', 'scope', 'head', 'target', 'digest', 'extra'] as const)('rejects %s capsule tampering', async change => {
    const f = await fixture(), c = structuredClone(f.capsule); if (change === 'reason') c.intent.reason = 'Different reason'; if (change === 'scope') c.scope.actorId = 'other_actor'; if (change === 'head') c.nextHead.expiresAt = new Date(now + 99999).toISOString(); if (change === 'target') c.expectedTarget.hash = 'a'.repeat(64); if (change === 'digest') c.commandHash = 'a'.repeat(64); if (change === 'extra') Object.assign(c, { proof: 'not_public' }); await expect(verifyAuthorityCapsule(c)).rejects.toThrow();
  });
  it('binds command digest to actor/route/kind and uses mandate_control rather than decision verification', async () => {
    const f = await fixture(), hashes = await authorityDigests(f.scope, f.capsule.intent);
    expect(hashes.intentHash).toBe(await commandDigest({ purpose: 'mandate_control', intent: f.capsule.intent })); expect(hashes.intentHash).not.toBe(await commandDigest({ purpose: 'mandate_authorization', intent: f.capsule.intent })); expect((await authorityDigests({ ...f.scope, actorId: 'other_actor' }, f.capsule.intent)).commandHash).not.toBe(hashes.commandHash); expect((await authorityDigests({ ...f.scope, responsibilityId: 'other_responsibility' }, f.capsule.intent)).commandHash).not.toBe(hashes.commandHash);
  });
  it('qualifies a historical transition without depending on any later current head', async () => { const f = await fixture(); f.page.head!.state = 'REVOKED'; f.page.head!.mandateEpoch = 10; expect(qualifyAuthorityReceipt(f.result, f.locator).recordedState).toBe('PAUSED'); expect(f.page.head!.mandateEpoch).toBe(10); });
  it.each(['kind', 'organization', 'environment', 'responsibility', 'target-hash', 'target-epoch', 'aggregate', 'command', 'intent', 'financial'] as const)('rejects receipt %s mismatch', async change => {
    const f = await fixture(), result = structuredClone(f.result); if (change === 'kind') result.kind = 'mandate.revoke'; if (change === 'organization') result.organizationId = 'other_org'; if (change === 'environment') result.operation.environment = 'production'; if (change === 'responsibility') result.responsibilityId = 'other_responsibility'; if (change === 'target-hash') result.target.hash = 'a'.repeat(64); if (change === 'target-epoch') { result.target.version++; result.operation.aggregateVersion++; } if (change === 'aggregate') result.operation.aggregateId = 'other_mandate'; if (change === 'command') result.commandHash = 'a'.repeat(64); if (change === 'intent') result.intentHash = 'a'.repeat(64); if (change === 'financial') Object.assign(result.operation, { financialState: 'PAID' }); expect(() => qualifyAuthorityOperation(result, f.locator)).toThrow();
  });
  it.each(['pending', 'error', 'next-check', 'evidence'] as const)('preserves an unconfirmed %s result without successful settlement', async change => {
    const f = await fixture(), result = structuredClone(f.result); if (change === 'pending') result.operation.status = 'pending'; if (change === 'error') result.operation.error = { code: 'UNCONFIRMED', detailRef: null, retryable: false }; if (change === 'next-check') result.operation.nextCheckAt = new Date(now + 5000).toISOString(); if (change === 'evidence') result.operation.evidenceRefs = ['not_a_control_evidence']; expect(() => qualifyAuthorityReceipt(result, f.locator)).toThrow();
  });
});
