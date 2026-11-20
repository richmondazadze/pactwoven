import { describe, expect, it, vi } from 'vitest';
import { ActorContextSchema } from '@pactwoven/contracts';
import { NativeAdvisoryHandoffSchema, NativeAdvisoryResultSchema, NativeDelegationRequestSchema,
  NativeDelegationIssuanceContextSchema, NativeDelegationCurrentAuthoritySchema, NativeHandoffParentSchema,
  NativeHandoffAssignmentSchema, NativeDelegationUsageSchema } from '../../contracts/src/native-delegation';
import { commandDigest } from './canonical.js';
import { nativeDelegationConsentDigest, issueNativeAdvisoryGrant, nativeDelegationReference,
  assertNativeDelegationCurrent, revokeNativeAdvisoryGrant, admitNativeAdvisoryHandoff, acceptNativeAdvisoryResult } from './native-delegation';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18) + seconds * 1_000).toISOString();
async function fixture() {
  let seconds = 0;
  const now = () => at(seconds);
  const request = NativeDelegationRequestSchema.parse({ grantId: 'grant_a', requestKey: 'issue_request_0001', mode: 'advise', externalEffects: 'forbidden',
    expiresAt: at(3_600), continuesAfterSignOut: true, scope: { environment: 'development', organizationId: 'org_a',
      issuer: { actorId: 'human_a', providerIssuer: 'https://test.clerk.accounts.dev', subject: 'user_a',
        externalOrganizationId: 'clerk_org_a', externalMembershipId: 'member_a', membershipVersion: 1 },
      organizationEpoch: 2, policyVersion: 1, purpose: 'Compare public delivery information without contacting anyone.',
      sites: [{ siteId: 'site_a', siteVersion: 1 }], capabilityVersion: 1, capabilities: ['draft_advice', 'read_scoped_memory'],
      limits: { maxDepth: 3, maxConcurrentChildren: 3, maxChildren: 32, maxAttempts: 4, taskTimeoutMs: 300_000 } } });
  const actor = ActorContextSchema.parse({ actorId: 'human_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: [], sessionId: 'session_a', authenticatedAt: at(-60), correlationId: 'correlation_a' });
  const issuance = NativeDelegationIssuanceContextSchema.parse({ actor, sessionVerifiedAt: at(0), sessionExpiresAt: at(600),
    consent: { actorId: actor.actorId, sessionId: actor.sessionId, scopeDigest: await nativeDelegationConsentDigest(request),
      confirmedAt: at(0), continuesAfterSignOut: true } });
  const currentAuthority = NativeDelegationCurrentAuthoritySchema.parse({ state: 'current', scope: structuredClone(request.scope), observedAt: at(0), validUntil: at(20) });
  const grant = await issueNativeAdvisoryGrant(request, { issuance, currentAuthority, now });
  const reference = await nativeDelegationReference(grant);
  const sender = { serviceId: 'coordinator', serviceVersion: 1, workloadIdentityId: 'coordinator_audience' };
  const recipient = { serviceId: 'research', serviceVersion: 1, workloadIdentityId: 'research_audience' };
  const handoff = NativeAdvisoryHandoffSchema.parse({ schemaVersion: 1, handoffId: 'handoff_a', environment: 'development', organizationId: 'org_a',
    siteId: 'site_a', authority: reference, rootTaskId: 'root_a', parentTaskId: 'root_a', childTaskId: 'child_a', assignmentVersion: 1, generation: 1,
    sender, recipient, capability: 'draft_advice', capabilityVersion: 1, depth: 1, attemptLimit: 3, taskTimeoutMs: 120_000,
    issuedAt: at(1), deadlineAt: at(121), inputArtifacts: [], outputContract: 'advisory_artifacts_v1', correlationId: 'correlation_a' });
  const parent = NativeHandoffParentSchema.parse({ environment: 'development', organizationId: 'org_a', siteId: 'site_a', rootTaskId: 'root_a',
    taskId: 'root_a', authority: reference, depth: 0, service: sender, state: 'running', ancestorTaskIds: ['root_a'] });
  const usage = NativeDelegationUsageSchema.parse({ grantId: grant.id, grantVersion: grant.version, revocationEpoch: grant.revocationEpoch,
    activeChildren: 0, childrenCreated: 0 });
  const assignment = NativeHandoffAssignmentSchema.parse({ handoffId: 'handoff_a', childTaskId: 'child_a', assignmentVersion: 1, generation: 1,
    attempt: 1, recipient, state: 'ready' });
  const result = NativeAdvisoryResultSchema.parse({ schemaVersion: 1, resultId: 'result_a', handoffId: 'handoff_a', handoffDigest: await commandDigest(handoff),
    environment: 'development', organizationId: 'org_a', siteId: 'site_a', childTaskId: 'child_a', assignmentVersion: 1, generation: 1,
    authority: reference, sender: recipient, recipient: sender, attempt: 1, outcome: 'advice_ready',
    artifacts: [{ environment: 'development', organizationId: 'org_a', siteId: 'site_a', artifactId: 'artifact_a', revision: 1, digest: 'a'.repeat(64) }],
    finishedAt: at(2), evidenceValidUntil: at(15) });
  const execution = { grant, reference, currentAuthority, siteId: 'site_a', capability: 'draft_advice' as const, now };
  const admission = { grant, currentAuthority, parent, assignment, usage, receiver: recipient, authenticate: vi.fn(async () => sender), now };
  const acceptance = { grant, currentAuthority, handoff, assignment: { ...assignment, state: 'running' as const }, receiver: sender,
    authenticate: vi.fn(async () => recipient), now,
    validateArtifacts: vi.fn(async (refs: readonly unknown[]) => ({ referenceDigest: await commandDigest(refs), observedAt: at(2), validUntil: at(20) })) };
  seconds = 3;
  return { request, actor, issuance, grant, reference, currentAuthority, handoff, parent, assignment, usage, result, execution, admission, acceptance, now,
    setTime: (value: number) => { seconds = value; } };
}

describe('advisory grants', () => {
  it('issues exact consent and validates without any continued browser session', async () => {
    const f = await fixture();
    f.issuance.sessionExpiresAt = at(1);
    expect(await assertNativeDelegationCurrent(f.execution)).toMatchObject({ permission: 'advisory_only', externalEffects: 'forbidden', validUntil: at(20) });
    expect(f.grant.issuance.continuesAfterSignOut).toBe(true);
    expect(Object.isFrozen(f.grant.scope.sites)).toBe(true);
  });
  it.each([
    ['service actor', (f: any) => { f.issuance.actor.principalKind = 'service'; }],
    ['read-only actor', (f: any) => { f.issuance.actor.roles = ['auditor']; }],
    ['wrong actor', (f: any) => { f.issuance.actor.actorId = 'human_b'; }],
    ['wrong session', (f: any) => { f.issuance.consent.sessionId = 'session_b'; }],
    ['expired session', (f: any) => { f.issuance.sessionExpiresAt = at(3); }],
    ['missing site access', (f: any) => { f.issuance.actor.siteIds = []; }],
    ['changed reviewed purpose', (f: any) => { f.request.scope.purpose = 'Do something different'; }],
    ['future consent', (f: any) => { f.issuance.consent.confirmedAt = at(4); }],
  ])('rejects issuance with %s', async (_name, mutate) => {
    const f = await fixture(); mutate(f);
    await expect(issueNativeAdvisoryGrant(f.request, f)).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_REQUIRED' });
  });
  it('does not refresh lifetime or revive a revoked grant on issuance replay', async () => {
    const f = await fixture();
    const command = { grantId: f.grant.id, expectedVersion: 1, expectedRevocationEpoch: 0, requestKey: 'revoke_request_001' };
    const revoked = revokeNativeAdvisoryGrant(f.grant, command, f.actor, f.now());
    const replay = await issueNativeAdvisoryGrant(f.request, { ...f, existing: revoked });
    expect(replay).toEqual(revoked);
    expect(replay.issuedAt).toBe(at(0));
    expect(revokeNativeAdvisoryGrant(replay, command, f.actor, at(4))).toEqual(revoked);
    await expect(assertNativeDelegationCurrent({ ...f.execution, grant: replay })).rejects.toMatchObject({ code: 'DELEGATION_REVOKED' });
  });
  it('rejects reusing a request identity for different scope', async () => {
    const f = await fixture(); f.request.scope.purpose = 'A changed objective';
    f.issuance.consent.scopeDigest = await nativeDelegationConsentDigest(f.request);
    await expect(issueNativeAdvisoryGrant(f.request, { ...f, existing: f.grant })).rejects.toMatchObject({ code: 'DELEGATION_IDEMPOTENCY_CONFLICT' });
  });
  it.each([
    ['issuer user', (v: any) => { v.scope.issuer.subject = 'user_b'; }],
    ['provider instance', (v: any) => { v.scope.issuer.providerIssuer = 'https://other.clerk.accounts.dev'; }],
    ['provider organization', (v: any) => { v.scope.issuer.externalOrganizationId = 'org_other'; }],
    ['replaced membership', (v: any) => { v.scope.issuer.externalMembershipId = 'replacement'; }],
    ['membership version', (v: any) => { v.scope.issuer.membershipVersion++; }],
    ['organization epoch', (v: any) => { v.scope.organizationEpoch++; }],
    ['policy version', (v: any) => { v.scope.policyVersion++; }],
    ['site version', (v: any) => { v.scope.sites[0].siteVersion++; }],
    ['lost site', (v: any) => { v.scope.sites = [{ siteId: 'other', siteVersion: 1 }]; }],
    ['lost capability', (v: any) => { v.scope.capabilities = ['read_scoped_memory']; }],
    ['reduced technical bound', (v: any) => { v.scope.limits.maxAttempts = 1; }],
    ['provider denial', (v: any) => { v.state = 'denied'; }],
  ])('fences current authority after %s', async (_name, mutate) => {
    const f = await fixture(); mutate(f.currentAuthority);
    await expect(assertNativeDelegationCurrent(f.execution)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('fails closed on provider outage and exact proof expiry', async () => {
    const f = await fixture(); f.currentAuthority.state = 'unavailable';
    await expect(assertNativeDelegationCurrent(f.execution)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_UNAVAILABLE' });
    f.currentAuthority.state = 'current'; f.setTime(20);
    await expect(assertNativeDelegationCurrent(f.execution)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('rejects the old reference even if stored scope changes without a version bump', async () => {
    const f = await fixture(); const changed = structuredClone(f.grant); changed.scope.purpose = 'Different work';
    await expect(assertNativeDelegationCurrent({ ...f.execution, grant: changed })).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
    await expect(nativeDelegationReference(changed)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('binds the stored grant version and revocation epoch independently of its scope', async () => {
    const f = await fixture();
    for (const changed of [{ ...f.grant, version: 2 }, { ...f.grant, revocationEpoch: 1 }]) {
      await expect(assertNativeDelegationCurrent({ ...f.execution, grant: changed })).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
    }
  });
  it('rejects grant expiry and still permits its issuer to revoke it afterward', async () => {
    const f = await fixture(); f.setTime(3_600);
    await expect(assertNativeDelegationCurrent(f.execution)).rejects.toMatchObject({ code: 'DELEGATION_EXPIRED' });
    expect(revokeNativeAdvisoryGrant(f.grant, { grantId: f.grant.id, expectedVersion: 1, expectedRevocationEpoch: 0,
      requestKey: 'revoke_request_001' }, f.actor, f.now()).revocation?.revokedAt).toBe(f.now());
  });
  it('rejects wrong-actor and stale-version revocation', async () => {
    const f = await fixture(); const command = { grantId: f.grant.id, expectedVersion: 1, expectedRevocationEpoch: 0, requestKey: 'revoke_request_001' };
    expect(() => revokeNativeAdvisoryGrant(f.grant, command, { ...f.actor, actorId: 'another' }, f.now())).toThrowError(expect.objectContaining({ code: 'DELEGATION_REVOKE_DENIED' }));
    expect(() => revokeNativeAdvisoryGrant(f.grant, { ...command, expectedVersion: 2 }, f.actor, f.now())).toThrowError(expect.objectContaining({ code: 'DELEGATION_AUTHORITY_CHANGED' }));
  });
});

describe('authenticated internal advisory handoff', () => {
  it('requires the exact sender and returns advisory-only admission', async () => {
    const f = await fixture(); const admitted = await admitNativeAdvisoryHandoff(f.handoff, f.admission);
    expect(admitted).toMatchObject({ disposition: 'admissible', permission: { externalEffects: 'forbidden' } });
    expect(f.admission.authenticate).toHaveBeenCalledWith({ kind: 'handoff', digest: await commandDigest(f.handoff) });
  });
  it.each([
    ['forged service', (f: any) => { f.admission.authenticate = async () => null; }, 'NATIVE_SERVICE_UNAUTHENTICATED'],
    ['wrong workload identity', (f: any) => { f.admission.authenticate = async () => ({ ...f.handoff.sender, workloadIdentityId: 'another' }); }, 'NATIVE_SERVICE_UNAUTHENTICATED'],
    ['wrong receiver', (f: any) => { f.admission.receiver = f.handoff.sender; }, 'NATIVE_HANDOFF_SCOPE_DENIED'],
    ['wrong parent tenant', (f: any) => { f.parent.organizationId = 'other'; }, 'NATIVE_HANDOFF_SCOPE_DENIED'],
    ['paused parent', (f: any) => { f.parent.state = 'paused'; }, 'NATIVE_DELEGATION_LIMIT'],
    ['concurrency full', (f: any) => { f.usage.activeChildren = 3; f.usage.childrenCreated = 3; }, 'NATIVE_DELEGATION_LIMIT'],
    ['lifetime fanout full', (f: any) => { f.usage.childrenCreated = 32; }, 'NATIVE_DELEGATION_LIMIT'],
    ['substituted usage counters', (f: any) => { f.usage.grantId = 'other_grant'; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['stale generation', (f: any) => { f.assignment.generation = 2; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['stale assignment version', (f: any) => { f.assignment.assignmentVersion = 2; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['exhausted attempts', (f: any) => { f.assignment.attempt = 4; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['cancelled assignment', (f: any) => { f.assignment.state = 'cancelled'; }, 'NATIVE_ASSIGNMENT_CHANGED'],
  ])('rejects %s', async (_name, mutate, code) => {
    const f = await fixture(); mutate(f);
    await expect(admitNativeAdvisoryHandoff(f.handoff, f.admission)).rejects.toMatchObject({ code });
  });
  it('retains duplicate identity without authorizing another execution', async () => {
    const f = await fixture(); f.parent.state = 'cancelled';
    expect(await admitNativeAdvisoryHandoff(f.handoff, { ...f.admission, existing: f.handoff })).toMatchObject({ disposition: 'duplicate', execution: 'none' });
    await expect(admitNativeAdvisoryHandoff({ ...f.handoff, correlationId: 'changed' }, { ...f.admission, existing: f.handoff }))
      .rejects.toMatchObject({ code: 'NATIVE_HANDOFF_IDEMPOTENCY_CONFLICT' });
  });
  it('rejects reusing an intermediate ancestor as a new child', async () => {
    const f = await fixture();
    f.parent.taskId = 'parent_c'; f.parent.depth = 2; f.parent.ancestorTaskIds = ['root_a', 'child_a', 'parent_c'];
    f.handoff.parentTaskId = 'parent_c'; f.handoff.depth = 3;
    await expect(admitNativeAdvisoryHandoff(f.handoff, f.admission)).rejects.toMatchObject({ code: 'NATIVE_DELEGATION_LIMIT' });
  });
  it('snapshots envelope and authority before asynchronous authentication', async () => {
    const f = await fixture(); const original = structuredClone(f.handoff);
    f.admission.authenticate = vi.fn(async () => {
      f.handoff.siteId = 'attacker_site'; f.parent.organizationId = 'attacker_org';
      f.currentAuthority.scope.issuer.subject = 'attacker_user'; return original.sender;
    });
    const admitted = await admitNativeAdvisoryHandoff(f.handoff, f.admission);
    expect(admitted.disposition === 'admissible' && admitted.handoff).toEqual(original);
  });
  it('rechecks clock after authentication stalls past authority expiry', async () => {
    const f = await fixture(); f.admission.authenticate = vi.fn(async () => { f.setTime(21); return f.handoff.sender; });
    await expect(admitNativeAdvisoryHandoff(f.handoff, f.admission)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('does not return an already-expired permission at the final handoff clock read', async () => {
    const f = await fixture(); let reads = 0;
    f.admission.now = () => at(++reads >= 2 ? 20 : 3);
    await expect(admitNativeAdvisoryHandoff(f.handoff, f.admission)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
});

describe('advisory result acceptance', () => {
  it('validates exact stored artifacts and never asserts external/domain completion', async () => {
    const f = await fixture(); const eligible = await acceptNativeAdvisoryResult(f.result, f.acceptance);
    expect(eligible).toMatchObject({ disposition: 'advisory_result_eligible', domainCompletion: false,
      permission: { permission: 'advisory_only', validUntil: at(15) } });
    expect(f.acceptance.validateArtifacts).toHaveBeenCalledWith(f.result.artifacts);
  });
  it.each([
    ['unauthenticated sender', (f: any) => { f.acceptance.authenticate = async () => null; }, 'NATIVE_SERVICE_UNAUTHENTICATED'],
    ['wrong handoff hash', (f: any) => { f.result.handoffDigest = 'f'.repeat(64); }, 'NATIVE_RESULT_SCOPE_DENIED'],
    ['wrong result generation', (f: any) => { f.result.generation = 2; }, 'NATIVE_RESULT_SCOPE_DENIED'],
    ['wrong current generation', (f: any) => { f.acceptance.assignment.generation = 2; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['old attempt', (f: any) => { f.acceptance.assignment.attempt = 2; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['stopped assignment', (f: any) => { f.acceptance.assignment.state = 'cancelled'; }, 'NATIVE_ASSIGNMENT_CHANGED'],
    ['future finish', (f: any) => { f.result.finishedAt = at(4); }, 'NATIVE_RESULT_EXPIRED'],
    ['missing artifact', (f: any) => { f.acceptance.validateArtifacts = async () => null; }, 'NATIVE_RESULT_ARTIFACTS_INVALID'],
    ['wrong artifact digest', (f: any) => { f.acceptance.validateArtifacts = async () => ({ referenceDigest: 'f'.repeat(64), observedAt: at(2), validUntil: at(20) }); }, 'NATIVE_RESULT_ARTIFACTS_INVALID'],
    ['worker overstates validity', (f: any) => { f.result.evidenceValidUntil = at(21); }, 'NATIVE_RESULT_ARTIFACTS_INVALID'],
  ])('rejects %s', async (_name, mutate, code) => {
    const f = await fixture(); mutate(f);
    await expect(acceptNativeAdvisoryResult(f.result, f.acceptance)).rejects.toMatchObject({ code });
  });
  it('records failure without inventing success artifacts', async () => {
    const f = await fixture(); f.result.outcome = 'failed'; f.result.artifacts = []; f.result.evidenceValidUntil = null;
    expect(await acceptNativeAdvisoryResult(f.result, f.acceptance)).toMatchObject({ disposition: 'advisory_result_eligible', domainCompletion: false });
    expect(f.acceptance.validateArtifacts).not.toHaveBeenCalled();
  });
  it('rejects a late result after asynchronous artifact validation', async () => {
    const f = await fixture(); f.acceptance.validateArtifacts = vi.fn(async refs => {
      f.setTime(21); return { referenceDigest: await commandDigest(refs), observedAt: at(2), validUntil: at(30) };
    });
    await expect(acceptNativeAdvisoryResult(f.result, f.acceptance)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('does not return an already-expired permission at the final result clock read', async () => {
    const f = await fixture(); let reads = 0;
    f.acceptance.now = () => at(++reads >= 5 ? 20 : 3);
    await expect(acceptNativeAdvisoryResult(f.result, f.acceptance)).rejects.toMatchObject({ code: 'DELEGATION_AUTHORITY_CHANGED' });
  });
  it('returns exact duplicate receipt and rejects a changed result for the same identity', async () => {
    const f = await fixture(); f.acceptance.assignment.state = 'cancelled' as never;
    expect(await acceptNativeAdvisoryResult(f.result, { ...f.acceptance, existing: f.result })).toMatchObject({ disposition: 'duplicate', execution: 'none' });
    await expect(acceptNativeAdvisoryResult({ ...f.result, resultId: 'new_result' }, { ...f.acceptance, existing: f.result }))
      .rejects.toMatchObject({ code: 'NATIVE_RESULT_IDEMPOTENCY_CONFLICT' });
    expect(f.acceptance.validateArtifacts).not.toHaveBeenCalled();
  });
});
