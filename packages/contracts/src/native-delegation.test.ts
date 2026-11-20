import { describe, expect, it } from 'vitest';
import { NativeAdvisoryGrantSchema, NativeAdvisoryHandoffSchema, NativeAdvisoryResultSchema,
  NativeDelegationRequestSchema, NativeTaskAuthoritySchema, NativeDelegationCurrentAuthoritySchema } from './native-delegation';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18) + seconds * 1_000).toISOString();
const scope = {
  environment: 'development', organizationId: 'org_a', issuer: { actorId: 'human_a',
    providerIssuer: 'https://test.clerk.accounts.dev', subject: 'user_a', externalOrganizationId: 'clerk_org_a',
    externalMembershipId: 'member_a', membershipVersion: 1 }, organizationEpoch: 2, policyVersion: 1,
  purpose: 'Compare delivery options without contacting anyone.', sites: [{ siteId: 'site_a', siteVersion: 1 }],
  capabilityVersion: 1, capabilities: ['draft_advice'],
  limits: { maxDepth: 3, maxConcurrentChildren: 3, maxChildren: 32, maxAttempts: 4, taskTimeoutMs: 300_000 },
};
const request = () => ({ grantId: 'grant_a', requestKey: 'issue_request_0001', mode: 'advise',
  externalEffects: 'forbidden', scope: structuredClone(scope), expiresAt: at(3_600), continuesAfterSignOut: true });
const grant = () => ({ schemaVersion: 1, id: 'grant_a', version: 1, revocationEpoch: 0, mode: 'advise',
  externalEffects: 'forbidden', scope: structuredClone(scope), issuedAt: at(0), expiresAt: at(3_600),
  issuance: { requestKey: 'issue_request_0001', sessionId: 'session_a', authenticatedAt: at(-60),
    confirmedAt: at(0), scopeDigest: 'a'.repeat(64), continuesAfterSignOut: true }, revocation: null });
const reference = { kind: 'delegated', grantId: 'grant_a', grantVersion: 1, revocationEpoch: 0, grantDigest: 'a'.repeat(64) };
const sender = { serviceId: 'coordinator', serviceVersion: 1, workloadIdentityId: 'coordinator_audience' };
const recipient = { serviceId: 'research', serviceVersion: 1, workloadIdentityId: 'research_audience' };
const artifact = { environment: 'development', organizationId: 'org_a', siteId: 'site_a', artifactId: 'artifact_a', revision: 1, digest: 'b'.repeat(64) };
const handoff = () => ({ schemaVersion: 1, handoffId: 'handoff_a', environment: 'development', organizationId: 'org_a', siteId: 'site_a',
  authority: structuredClone(reference), rootTaskId: 'task_a', parentTaskId: 'task_a', childTaskId: 'task_b',
  assignmentVersion: 1, generation: 1, sender, recipient, capability: 'draft_advice', capabilityVersion: 1,
  depth: 1, attemptLimit: 3, taskTimeoutMs: 120_000, issuedAt: at(1), deadlineAt: at(121),
  inputArtifacts: [structuredClone(artifact)], outputContract: 'advisory_artifacts_v1', correlationId: 'correlation_a' });
const result = () => ({ schemaVersion: 1, resultId: 'result_a', handoffId: 'handoff_a', handoffDigest: 'c'.repeat(64),
  environment: 'development', organizationId: 'org_a', siteId: 'site_a', childTaskId: 'task_b',
  assignmentVersion: 1, generation: 1, authority: structuredClone(reference), sender: recipient, recipient: sender,
  attempt: 1, outcome: 'advice_ready', artifacts: [structuredClone(artifact)], finishedAt: at(2), evidenceValidUntil: at(15) });

describe('explicit advisory delegation contracts', () => {
  it('accepts explicit advisory grant and service envelopes', () => {
    expect(NativeDelegationRequestSchema.safeParse(request()).success).toBe(true);
    expect(NativeAdvisoryGrantSchema.safeParse(grant()).success).toBe(true);
    expect(NativeAdvisoryHandoffSchema.safeParse(handoff()).success).toBe(true);
    expect(NativeAdvisoryResultSchema.safeParse(result()).success).toBe(true);
  });
  it.each([
    ['missing consent', (v: any) => delete v.continuesAfterSignOut],
    ['implicit logout permission', (v: any) => { v.continuesAfterSignOut = false; }],
    ['effectful mode', (v: any) => { v.mode = 'act'; }],
    ['external effect permission', (v: any) => { v.externalEffects = 'allowed'; }],
    ['message capability', (v: any) => { v.scope.capabilities = ['send_email']; }],
    ['payment field', (v: any) => { v.paymentApproval = true; }],
    ['duplicate site', (v: any) => { v.scope.sites.push(v.scope.sites[0]); }],
    ['duplicate capability', (v: any) => { v.scope.capabilities.push('draft_advice'); }],
    ['zero attempts', (v: any) => { v.scope.limits.maxAttempts = 0; }],
    ['unbounded retry', (v: any) => { v.scope.limits.maxAttempts = 5; }],
    ['unbounded depth', (v: any) => { v.scope.limits.maxDepth = 4; }],
    ['unbounded concurrency', (v: any) => { v.scope.limits.maxConcurrentChildren = 4; }],
    ['unbounded fanout', (v: any) => { v.scope.limits.maxChildren = 33; }],
    ['unsafe epoch', (v: any) => { v.scope.organizationEpoch = Number.MAX_SAFE_INTEGER + 1; }],
    ['Azure spend cap', (v: any) => { v.scope.azureBudget = 1; }],
  ])('rejects %s', (_name, mutate) => {
    const value = request(); mutate(value); expect(NativeDelegationRequestSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    ['expired interval', (v: any) => { v.expiresAt = at(0); }],
    ['overlong lifetime', (v: any) => { v.expiresAt = at(86_401); }],
    ['confirmation after issue', (v: any) => { v.issuance.confirmedAt = at(1); }],
    ['revocation before issue', (v: any) => { v.revocation = { requestKey: 'revoke_request_001', actorId: 'human_a', revokedAt: at(-1) }; }],
  ])('rejects grant %s', (_name, mutate) => {
    const value = grant(); mutate(value); expect(NativeAdvisoryGrantSchema.safeParse(value).success).toBe(false);
  });
  it('retains interactive session authority as a separate explicit variant', () => {
    const interactive = { kind: 'interactive_session', sessionId: 'session_a', providerIssuer: scope.issuer.providerIssuer };
    expect(NativeTaskAuthoritySchema.parse(interactive).kind).toBe('interactive_session');
    expect(NativeTaskAuthoritySchema.safeParse({ sessionId: 'session_a' }).success).toBe(false);
    expect(NativeAdvisoryHandoffSchema.safeParse({ ...handoff(), authority: interactive }).success).toBe(false);
    expect(NativeTaskAuthoritySchema.safeParse({ ...reference, sessionId: 'session_a' }).success).toBe(false);
  });
  it('bounds authority observations and rejects session-status fallback fields', () => {
    const current = { state: 'current', scope, observedAt: at(0), validUntil: at(20) };
    expect(NativeDelegationCurrentAuthoritySchema.safeParse(current).success).toBe(true);
    expect(NativeDelegationCurrentAuthoritySchema.safeParse({ ...current, validUntil: at(21) }).success).toBe(false);
    expect(NativeDelegationCurrentAuthoritySchema.safeParse({ ...current, sessionActive: true }).success).toBe(false);
  });
  it.each([
    ['self child', (v: any) => { v.childTaskId = v.parentTaskId; }],
    ['root cycle', (v: any) => { v.childTaskId = v.rootTaskId; }],
    ['false lineage depth', (v: any) => { v.depth = 2; }],
    ['same sender and receiver', (v: any) => { v.recipient = v.sender; }],
    ['cross-tenant input', (v: any) => { v.inputArtifacts[0].organizationId = 'org_b'; }],
    ['cross-site input', (v: any) => { v.inputArtifacts[0].siteId = 'site_b'; }],
    ['duplicate input reference', (v: any) => { v.inputArtifacts.push(v.inputArtifacts[0]); }],
    ['unbounded task window', (v: any) => { v.deadlineAt = at(122); }],
    ['forged authentication flag', (v: any) => { v.authenticated = true; }],
  ])('rejects handoff %s', (_name, mutate) => {
    const value = handoff(); mutate(value); expect(NativeAdvisoryHandoffSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    ['transport success as completion', (v: any) => { v.outcome = 'completed'; }],
    ['no artifacts for advice', (v: any) => { v.artifacts = []; }],
    ['cross-tenant output', (v: any) => { v.artifacts[0].organizationId = 'org_b'; }],
    ['expired evidence', (v: any) => { v.evidenceValidUntil = v.finishedAt; }],
    ['failed result with artifacts', (v: any) => { v.outcome = 'failed'; }],
    ['supplier booking claim', (v: any) => { v.bookingConfirmed = true; }],
  ])('rejects result %s', (_name, mutate) => {
    const value = result(); mutate(value); expect(NativeAdvisoryResultSchema.safeParse(value).success).toBe(false);
  });
});
