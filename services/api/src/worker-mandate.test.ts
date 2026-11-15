import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActorContext, type CreateMandateDocumentRequest, type MandateAuthorityIntent, type MandateDecisionIntent,
  type MandateGateway, type MandateOperationResult, type MandatePage, type MandateReview, type ProposeMandateCommand, type Responsibility } from '@pactwoven/contracts';
import { createPolicyDocumentVersion, createMandateProposal, mandateReference, mandateResponsibilityReference, mandateIntentHash, DomainError } from '@pactwoven/domain';
import { mandateUrl, mandateRequestBytes, mandateResponseBytes, handlePrivateMandateRequest, serviceMandateGateway } from './worker-mandate.js';

const issuer = 'https://worker-fixture.clerk.accounts.dev';
const token = 'synthetic-mandate-token', key = 'mandate_request_key_001', trace = 'mandate_trace';
const responsibilityId = 'responsibility_a', proposalId = 'proposal_a', mandateId = 'mandate_a';
const base = `/v1/responsibilities/${responsibilityId}`;
const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
const gateway = { readDocument: vi.fn(), list: vi.fn(), review: vi.fn(), operation: vi.fn(), createDocument: vi.fn(), propose: vi.fn(), decide: vi.fn(), control: vi.fn() } satisfies MandateGateway;
const factory = vi.fn((_nonce: string) => gateway);
const fetchPrivate = (request: Request) => handlePrivateMandateRequest(request, issuer, factory);
function publicRequest(path = `${base}/mandate-proposals/${proposalId}/decision`, method = 'POST') {
  return new Request(`https://api.example${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key } });
}
const adapter = (path?: string, method = 'POST', fetch = fetchPrivate) => serviceMandateGateway({ fetch }, publicRequest(path, method), issuer);
let documentRequest: CreateMandateDocumentRequest, proposalCommand: ProposeMandateCommand, intent: MandateDecisionIntent, control: MandateAuthorityIntent;
let page: MandatePage, review: MandateReview;
async function result(kind: MandateOperationResult['kind'], id: string, version: number, command?: MandateDecisionIntent | MandateAuthorityIntent): Promise<MandateOperationResult> {
  const targetKind = kind === 'mandate.document.create' ? 'document' : kind === 'mandate.propose' ? 'proposal'
    : kind === 'mandate.authorize' || kind === 'mandate.reject' ? 'decision' : 'authority';
  return { schemaVersion: 1, organizationId: 'org_a', operation: { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: id,
    aggregateVersion: version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null }, kind, responsibilityId,
    target: { kind: targetKind, id, version, hash: 'c'.repeat(64) }, commandHash: 'b'.repeat(64), intentHash: command ? await mandateIntentHash(command) : null, observedAt: new Date().toISOString() };
}
function input() { return { nonce: crypto.randomUUID(), request: { url: publicRequest().url, method: 'POST', correlationId: trace },
  action: { kind: 'decide', responsibilityId, proposalId, key, command: structuredClone(intent) } }; }
function privateRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(mandateUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  vi.resetAllMocks(); factory.mockImplementation(() => gateway);
  const now = new Date().toISOString(), expiry = new Date(Date.now() + 3_600_000).toISOString();
  const actor: ActorContext = { actorId: 'requester_a', principalKind: 'human', organizationId: 'org_a', environment: 'development', roles: ['operations'],
    siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: now, correlationId: trace };
  const responsibility: Responsibility = { id: responsibilityId, organizationId: 'org_a', environment: 'development', ownerId: actor.actorId, title: 'Prepare an event',
    description: '', siteId: 'site_a', version: 1, window: { startsAt: now, endsAt: expiry, timeZone: 'America/Chicago' }, requirements: [],
    acceptancePolicy: 'Require delivery evidence.', executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt: now, updatedAt: now };
  const responsibilityRef = await mandateResponsibilityReference(responsibility);
  const acceptance = await createPolicyDocumentVersion({ actor, now }, { documentId: 'acceptance_a', expectedVersion: 0, previousVersion: null, purpose: 'ACCEPTANCE_POLICY', text: responsibility.acceptancePolicy }, null);
  documentRequest = { responsibility: responsibilityRef, expectedOrganizationEpoch: 2,
    command: { documentId: 'policy_a', expectedVersion: 0, previousVersion: null, purpose: 'MANDATE_POLICY', text: 'Advise only.' } };
  const document = await createPolicyDocumentVersion({ actor, now }, documentRequest.command, null);
  proposalCommand = { proposalId, expectedProposalVersion: 0, previousProposal: null, mandateId, responsibility: responsibilityRef,
    expectedOrganizationEpoch: 2, previousAcceptedVersion: null, expectedHead: null, policyDocument: mandateReference(document), expiresAt: expiry,
    policy: { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [], acceptancePolicy: mandateReference(acceptance),
      communication: { maximumMessages: 0, recipientIds: [], purposes: [], messageKinds: [], expiresAt: expiry }, expiresAt: expiry } };
  const proposed = await createMandateProposal({ organizationId: 'org_a', environment: 'development', organizationEpoch: 2, now, responsibility,
    site: { id: 'site_a', organizationId: 'org_a', environment: 'development', active: true }, acceptedVersion: null, head: null, documents: [acceptance, document],
    actor, operationId: 'propose_a', previousProposal: null, previousDecision: null }, proposalCommand);
  intent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: mandateReference(proposed.proposal), expectedDecisionVersion: 1, expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
  control = { schemaVersion: 1, action: 'PAUSE', mandate: { id: mandateId, version: 1, hash: 'a'.repeat(64) },
    head: { mandateId, mandateVersion: 1, mandateEpoch: 7, hash: 'b'.repeat(64) }, responsibility: responsibilityRef, expectedOrganizationEpoch: 2, reason: 'Pause new authority.' };
  const site = { id: 'site_a', name: 'Foundation site', timeZone: 'America/Chicago' };
  const effectiveAuthority = { state: 'NONE' as const, blockers: ['NO_ACCEPTED_MANDATE'] };
  page = { schemaVersion: 1, organizationId: 'org_a', environment: 'development', organizationEpoch: 2, responsibility, responsibilityReference: responsibilityRef,
    site, items: [], nextCursor: null, acceptedVersion: null, head: null, effectiveAuthority, eligibility: [], observedAt: now };
  review = { schemaVersion: 1, envelope: { schemaVersion: 1, observedAt: now, organizationEpoch: 2, responsibility, responsibilityReference: responsibilityRef, site,
    proposal: proposed.proposal, decision: proposed.decision, acceptedVersion: null, head: null, acceptedProposal: null, acceptedDecision: null, financialState: null,
    policyDocuments: [acceptance, document], eligibility: [], supportedPolicy: { mode: 'ADVISE', financialActions: [], monetaryBudgets: false, supplierReferences: false, outboundCommunication: false }, operation: null },
    responsibilityVersions: [responsibility], effectiveAuthority, effectiveDecisionState: 'OPEN' };
  gateway.list.mockImplementation(async () => structuredClone(page)); gateway.review.mockImplementation(async () => structuredClone(review));
  gateway.createDocument.mockImplementation(async () => result('mandate.document.create', 'policy_a', 1));
  gateway.propose.mockImplementation(async () => result('mandate.propose', proposalId, 1));
  gateway.decide.mockImplementation(async (_token, _responsibility, _proposal, _key, command) => result(command.action === 'AUTHORIZE' ? 'mandate.authorize' : 'mandate.reject', proposalId, 2, command));
  gateway.control.mockImplementation(async (_token, _responsibility, _mandate, _key, command) => result(`mandate.${command.action.toLowerCase()}` as MandateOperationResult['kind'], mandateId, 8, command));
  gateway.operation.mockImplementation(async () => result('mandate.authorize', proposalId, 2, intent));
});

describe('private mandate transport', () => {
  it('forwards only the original token, exact command and request nonce to the private factory', async () => {
    let forwarded: Record<string, any> | undefined;
    const fetch = vi.fn(async (request: Request) => {
      expect([...request.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
      expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`); expect(request.url).toBe(mandateUrl);
      expect(request.redirect).toBe('manual'); forwarded = await request.clone().json(); return fetchPrivate(request);
    });
    const response = await adapter(undefined, 'POST', fetch).decide(token, responsibilityId, proposalId, key, intent, trace);
    expect(response.kind).toBe('mandate.authorize'); expect(Object.keys(forwarded!).sort()).toEqual(['action', 'nonce', 'request']);
    expect(factory).toHaveBeenCalledExactlyOnceWith(forwarded!.nonce);
    expect(gateway.decide).toHaveBeenCalledExactlyOnceWith(token, responsibilityId, proposalId, key, intent, trace);
    expect(gateway.control).not.toHaveBeenCalled();
  });
  it('routes every read, write and authority action through the exact gateway method', async () => {
    expect(await adapter(`${base}/mandates?limit=10`, 'GET').list(token, responsibilityId, { limit: 10 }, trace)).toEqual(page);
    expect(await adapter(`${base}/mandates/${proposalId}?version=1`, 'GET').review(token, responsibilityId, proposalId, { version: 1 }, trace)).toEqual(review);
    expect((await adapter(`${base}/mandate-policy-documents`).createDocument(token, responsibilityId, key, documentRequest, trace)).target.id).toBe('policy_a');
    expect((await adapter(`${base}/mandate-proposals`).propose(token, responsibilityId, key, proposalCommand, trace)).kind).toBe('mandate.propose');
    for (const action of ['AUTHORIZE', 'REJECT'] as const) {
      const command = { ...intent, action, reason: action === 'REJECT' ? 'Not accepted.' : null };
      expect((await adapter().decide(token, responsibilityId, proposalId, key, command, trace)).intentHash).toBe(await mandateIntentHash(command));
    }
    for (const action of ['PAUSE', 'REVOKE', 'RESUME'] as const) {
      const command = { ...control, action };
      expect((await adapter(`${base}/mandates/${mandateId}/authority`).control(token, responsibilityId, mandateId, key, command, trace)).target.version).toBe(8);
    }
    expect((await adapter(`/v1/mandate-operations?kind=mandate.authorize&key=${key}`, 'GET').operation(token, { kind: 'mandate.authorize', key }, trace)).kind).toBe('mandate.authorize');
  });
  it('rejects token, key, method, target and duplicate-query substitution before dispatch', async () => {
    const fetch = vi.fn(fetchPrivate);
    await expect(adapter(undefined, 'POST', fetch).decide('other-token', responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    for (const [path, method] of [[`${base}/mandate-proposals/${proposalId}/decision`, 'GET'], [`${base}/mandate-proposals/other/decision`, 'POST'], [`${base}/mandate-proposals/${proposalId}/decision?x=1`, 'POST']]) {
      await expect(adapter(path, method, fetch).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
    await expect(adapter(undefined, 'POST', fetch).decide(token, responsibilityId, proposalId, 'changed_key_0001', intent, trace)).rejects.toThrow();
    await expect(adapter(undefined, 'POST', fetch).decide(token, responsibilityId, proposalId, key, { ...intent, proposal: { ...intent.proposal, id: 'other_proposal' } }, trace)).rejects.toThrow();
    await expect(adapter(`${base}/mandate-policy-documents`, 'POST', fetch).createDocument(token, responsibilityId, key, { ...documentRequest, responsibility: { ...documentRequest.responsibility, id: 'other' } }, trace)).rejects.toThrow();
    for (const suffix of ['?version=2', '?version=1&version=1', '?version=1&unknown=1']) {
      await expect(adapter(`${base}/mandates/${proposalId}${suffix}`, 'GET', fetch).review(token, responsibilityId, proposalId, { version: 1 }, trace)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects tampering of every response affinity field, including bound errors and payload identity', async () => {
    const changes: ((data: Record<string, any>) => void)[] = [
      d => { d.nonce = crypto.randomUUID(); }, d => { d.tokenHash = 'f'.repeat(64); }, d => { d.requestHash = 'f'.repeat(64); }, d => { d.commandHash = 'f'.repeat(64); },
      d => { d.request.method = 'GET'; }, d => { d.request.url += '?replay=1'; }, d => { d.request.correlationId = 'other_trace'; },
      d => { d.kind = 'control'; }, d => { d.responsibilityId = 'other'; }, d => { d.targetId = 'other'; }, d => { d.key = 'other_key_0001'; },
      d => { d.issuer = 'https://other.clerk.accounts.dev'; }, d => { d.environment = 'production'; },
      d => { d.respondedAt = new Date(Date.now() - 60_000).toISOString(); }, d => { d.respondedAt = new Date(Date.now() + 60_000).toISOString(); },
      d => { d.identity = { roles: ['owner'] }; }, d => { d.outcome.message = 'private-details'; },
      d => { d.outcome.data.operation.environment = 'production'; }, d => { d.outcome.data.operation.financialState = 'CONFIRMED'; },
      d => { d.outcome.data.responsibilityId = 'other'; }, d => { d.outcome.data.intentHash = 'f'.repeat(64); },
      d => { d.outcome.data.target.id = 'other'; d.outcome.data.operation.aggregateId = 'other'; },
      d => { d.outcome.data.target.version = 3; d.outcome.data.operation.aggregateVersion = 3; },
      d => { d.outcome.data.kind = 'mandate.reject'; }, d => { d.outcome.data.operation.error = { code: 'private-driver-detail', retryable: false, detailRef: null }; },
    ];
    for (const change of changes) {
      const fetch = vi.fn(async (request: Request) => { const data = await (await fetchPrivate(request)).json() as Record<string, any>; change(data); return Response.json(data, { headers }); });
      await expect(adapter(undefined, 'POST', fetch).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('rejects wrong responsibility/proposal/version read results and financial contamination', async () => {
    for (const change of [(r: MandateReview) => { r.envelope.proposal!.version++; r.envelope.decision!.proposal.version++; },
      (r: MandateReview) => { r.envelope.proposal!.id = 'other'; r.envelope.decision!.proposal.id = 'other'; },
      (r: MandateReview) => { r.envelope.responsibility.id = 'other'; },
      (r: MandateReview) => { r.envelope.financialState = 'CONFIRMED'; },
      (r: MandateReview) => { r.responsibilityVersions[0]!.environment = 'production'; }]) {
      const malformed = structuredClone(review); change(malformed); gateway.review.mockResolvedValue(malformed);
      await expect(adapter(`${base}/mandates/${proposalId}?version=1`, 'GET').review(token, responsibilityId, proposalId, { version: 1 }, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
    gateway.list.mockResolvedValue({ ...page, organizationId: 'other' });
    await expect(adapter(`${base}/mandates`, 'GET').list(token, responsibilityId, { limit: 25 }, trace)).rejects.toThrow();
    gateway.operation.mockResolvedValue(await result('mandate.reject', proposalId, 2, { ...intent, action: 'REJECT', reason: 'No' }));
    await expect(adapter(`/v1/mandate-operations?kind=mandate.authorize&key=${key}`, 'GET').operation(token, { kind: 'mandate.authorize', key }, trace)).rejects.toThrow();
  });
  it('rejects concurrent response swaps and replays of both success and sanitized error receipts', async () => {
    const pending: { response: Response; resolve: (value: Response) => void }[] = [];
    const swapped = async (request: Request) => { const response = await fetchPrivate(request); return new Promise<Response>(resolve => {
      pending.push({ response, resolve }); if (pending.length === 2) { pending[0]!.resolve(pending[1]!.response); pending[1]!.resolve(pending[0]!.response); }
    }); };
    const outcomes = await Promise.allSettled([1, 2].map(() => adapter(undefined, 'POST', swapped).decide(token, responsibilityId, proposalId, key, intent, trace)));
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const denied of [false, true]) {
      if (denied) gateway.decide.mockRejectedValue(new DomainError('FORBIDDEN', 403, 'private-details'));
      let saved: Response | undefined;
      const fetch = async (request: Request) => { saved ??= await fetchPrivate(request); return saved.clone(); };
      const value = adapter(undefined, 'POST', fetch);
      if (denied) await expect(value.decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      else await expect(value.decide(token, responsibilityId, proposalId, key, intent, trace)).resolves.toHaveProperty('operation');
      await expect(value.decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
  });
  it('preserves uncertain and terminal original operation states with no automatic resend', async () => {
    for (const status of ['accepted', 'pending', 'failed', 'unknown'] as const) {
      const original = await result('mandate.authorize', proposalId, 2, intent); original.operation.status = status;
      if (status === 'unknown') original.operation.error = { code: 'OUTCOME_UNKNOWN', retryable: false, detailRef: null };
      gateway.operation.mockResolvedValue(original); const fetch = vi.fn(fetchPrivate);
      expect(await adapter(`/v1/mandate-operations?kind=mandate.authorize&key=${key}`, 'GET', fetch).operation(token, { kind: 'mandate.authorize', key }, trace)).toEqual(original);
      expect(fetch).toHaveBeenCalledOnce();
    }
    expect(gateway.decide).not.toHaveBeenCalled();
  });
  it('returns fixed bound error messages and rejects unbound, status-mismatched and nonprivate responses', async () => {
    for (const [code, status] of [['AUTH_REQUIRED', 401], ['FORBIDDEN', 403], ['STEP_UP_REQUIRED', 403], ['INDEPENDENT_APPROVER_REQUIRED', 403],
      ['PROPOSAL_EXPIRED', 409], ['DECISION_TERMINAL', 409], ['POLICY_DOCUMENT_INVALID', 409], ['MANDATE_POLICY_UNSUPPORTED', 422], ['INTEGRITY_ERROR', 503]] as const) {
      gateway.decide.mockRejectedValue(new DomainError(code, status, 'private-provider-detail'));
      await expect(adapter().decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code, status, message: expect.not.stringContaining('private-provider-detail') });
    }
    for (const error of [new Error('private-driver-detail'), new DomainError('FORBIDDEN', 503, 'private-status-detail')]) {
      gateway.decide.mockRejectedValue(error);
      await expect(adapter().decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
    gateway.decide.mockImplementation(async () => result('mandate.authorize', proposalId, 2, intent));
    for (const alter of [(r: Response) => new Response(r.body, { status: 201, headers: r.headers }),
      (r: Response) => { r.headers.set('Cache-Control', 'public, max-age=60'); return r; },
      (r: Response) => { r.headers.set('Content-Type', 'text/plain'); return r; }]) {
      await expect(adapter(undefined, 'POST', async request => alter(await fetchPrivate(request))).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toThrow();
    }
    await expect(adapter(undefined, 'POST', async () => Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 })).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toThrow();
  });
  it('bounds oversized/stalled responses and never retries a potentially committed action', async () => {
    const cancel = vi.fn(), fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(mandateResponseBytes + 1)); }, cancel })));
    await expect(adapter(undefined, 'POST', fetch).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => new Response(new ReadableStream({ cancel })));
      const rejection = expect(adapter(undefined, 'POST', stalled).decide(token, responsibilityId, proposalId, key, intent, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      await vi.waitFor(() => expect(stalled).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(20_001); await rejection;
      expect(stalled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('private mandate intake', () => {
  it('rejects caller identity/proof, mismatched route targets and extra command properties before factory creation', async () => {
    const valid = input();
    for (const value of [{ ...valid, identity: { roles: ['owner'] } }, { ...valid, proof: { verified: true } }, { ...valid, nonce: 'invalid' },
      { ...valid, action: { ...valid.action, actorId: 'owner' } }, { ...valid, action: { ...valid.action, command: { ...intent, stepUp: true } } },
      { ...valid, action: { ...valid.action, proposalId: 'other' } }, { ...valid, request: { ...valid.request, method: 'GET' } },
      { ...valid, request: { ...valid.request, url: 'https://api.example/other' } }]) expect((await fetchPrivate(privateRequest(value))).status).toBe(422);
    expect(factory).not.toHaveBeenCalled();
  });
  it('accepts only the exact internal POST URL and a bearer token', async () => {
    for (const request of [new Request(mandateUrl), new Request(`${mandateUrl}?x=1`, { method: 'POST' }), new Request('https://public.example/internal/mandates/dispatch', { method: 'POST' })]) {
      expect((await fetchPrivate(request)).status).toBe(404);
    }
    expect((await fetchPrivate(privateRequest(input(), { Authorization: '', 'X-Actor-Id': 'owner' }))).status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects oversized, malformed, invalid-UTF8 and stalled bodies before a gateway exists', async () => {
    for (const request of [privateRequest(input(), { 'Content-Type': 'text/plain' }), privateRequest(input(), { 'Content-Length': String(mandateRequestBytes + 1) }),
      privateRequest(input(), { 'Content-Length': 'bad' }), privateRequest({ padding: 'x'.repeat(mandateRequestBytes + 1) }),
      new Request(mandateUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) })]) {
      expect((await fetchPrivate(request)).status).toBe(422);
    }
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const request = new Request(mandateUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
      const pending = fetchPrivate(request); await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(422); expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
    expect(factory).not.toHaveBeenCalled();
  });
});
