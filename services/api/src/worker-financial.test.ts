import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { financialPolicyHttpRequestHash, financialPolicyTextHash, DomainError } from '@pactwoven/domain';
import type { FinancialPolicyWriteRequest } from './financial-policy-write-service.js';
import { financialUrl, financialRequestBytes, financialResponseBytes, handlePrivateFinancialRequest,
  serviceFinancialGateways, type FinancialGateways } from './worker-financial.js';

const token = 'synthetic.financial.token', issuer = 'https://financial-fixture.clerk.accounts.dev', trace = 'financial_trace';
const rid = 'responsibility_a', key = 'original_request_0001', id = 'document_a', hash = 'a'.repeat(64), uuid = '00000000-0000-4000-8000-000000000001';
const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 2 },
  organizationEpoch: 3, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
const observation = () => ({ observedAt: new Date(Date.now() - 500).toISOString(), expiresAt: new Date(Date.now() + 19_000).toISOString() });
const envelope = () => ({ schemaVersion: 1, scope: structuredClone(scope), observation: observation(), effectiveAuthority: false, financialState: null });
const index = () => ({ ...envelope(), kind: 'organization', responsibilityId: null, items: [], nextId: null });
const selection = { schemaVersion: 1 as const, action: 'save_document' as const, targetId: id, previous: null, purpose: 'budget_policy' as const };
const write: Extract<FinancialPolicyWriteRequest, { kind: 'save_document' }> = { kind: 'save_document', responsibilityId: null, id, key, route: `/v1/financial-governance/documents/${id}`,
  input: { schemaVersion: 1, previous: null, organizationEpoch: 3, purpose: 'budget_policy', text: 'Exact reviewed policy.' } };
const gateway = {
  financialPolicy: { context: vi.fn(), index: vi.fn(), get: vi.fn(), recover: vi.fn() },
  financialPolicyWrite: { submit: vi.fn() }, financialPolicyPreparation: { prepare: vi.fn() },
  custodySetup: { recoveryContext: vi.fn(), prepare: vi.fn(), challenge: vi.fn(), confirmation: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), get: vi.fn(), recover: vi.fn() },
} satisfies FinancialGateways;
const factory = vi.fn(() => gateway);
const privateFetch = (request: Request) => handlePrivateFinancialRequest(request, issuer, factory);
function original(path = '/v1/financial-governance', method = 'GET', requestKey: string | null = null) {
  return new Request(`https://api.example${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': trace, ...(requestKey ? { 'Idempotency-Key': requestKey } : {}) } });
}
const adapter = (path?: string, method?: string, requestKey?: string | null, fetch = privateFetch) => serviceFinancialGateways({ fetch }, original(path, method, requestKey), issuer);
const privateRequest = (input: unknown, extra: Record<string, string> = {}) => new Request(financialUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) });
function input(action: object, path = '/v1/financial-governance', method = 'GET') { return { nonce: crypto.randomUUID(), request: { url: original(path, method).url, method, correlationId: trace }, action }; }
async function receipt() {
  const record = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: null,
    id, version: 1, predecessor: null, actor: scope.actor, organizationEpoch: 3, operationId: uuid,
    createdAt: new Date(Date.now() - 1000).toISOString(), kind: 'document', purpose: 'budget_policy', text: write.input.text,
    contentHash: await financialPolicyTextHash(write.input.text) };
  return { ...envelope(), status: 'recorded', receipt: { schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    actor: scope.actor, responsibilityId: null, operationId: uuid, kind: write.kind, key,
    publicRequestHash: await financialPolicyHttpRequestHash({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a' }, write),
    target: { id, version: 1, recordHash: hash }, record, effectiveAuthority: false, financialState: null } };
}
beforeEach(() => {
  vi.resetAllMocks(); factory.mockImplementation(() => gateway);
  gateway.financialPolicy.index.mockImplementation(async () => index());
  gateway.financialPolicyWrite.submit.mockImplementation(receipt);
  gateway.financialPolicyPreparation.prepare.mockImplementation(async () => ({ ...envelope(), responsibilityId: null, selection,
    decision: { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null },
    target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
    material: { action: 'save_document', purpose: 'budget_policy', organizationEpoch: 3, draftScope: null, siteActive: null },
    configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] }));
  gateway.custodySetup.recoveryContext.mockImplementation(async () => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    externalOrganizationId: 'clerk_org_a', responsibilityId: rid, owner: { ...scope.actor, subject: 'user_a', externalMembershipId: 'member_a', sessionId: 'session_a' }, ...observation() }));
  gateway.custodySetup.recover.mockImplementation(async (_token, responsibilityId, query) => ({ schemaVersion: 1, organizationId: 'org_a', actorId: 'actor_a',
    responsibilityId, ...(query as object), status: 'not_recorded', operation: null }));
});
afterEach(() => vi.useRealTimers());
describe('bounded private financial service protocol', () => {
  it('forwards the exact bearer, public command, scope and request without caller evidence', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect([...request.headers.keys()].sort()).toEqual(['authorization', 'content-type']); expect(request.redirect).toBe('manual');
      expect(request.url).toBe(financialUrl); expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`);
      const sent = await request.clone().json(); expect(Object.keys(sent).sort()).toEqual(['action', 'nonce', 'request']);
      expect(sent.action).toEqual({ kind: 'policy-submit', command: write }); return privateFetch(request);
    });
    const result = await adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, write);
    expect(result.receipt.key).toBe(key); expect(gateway.financialPolicyWrite.submit).toHaveBeenCalledExactlyOnceWith(token, write);
    expect(fetch).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
  });
  it('supports fresh policy index/preparation and custody recovery/context responses', async () => {
    expect((await adapter().financialPolicy.index(token, null, { afterId: null, limit: 20 })).items).toEqual([]);
    expect((await adapter('/v1/financial-governance-preparation', 'POST').financialPolicyPreparation.prepare(token, null, selection)).selection).toEqual(selection);
    expect((await adapter(`/v1/responsibilities/${rid}/custody-setups/recovery-context`).custodySetup.recoveryContext(token, rid, trace)).responsibilityId).toBe(rid);
    expect((await adapter(`/v1/responsibilities/${rid}/custody-setups/operations/${key}?kind=cancel`).custodySetup.recover(token, rid, { kind: 'cancel', key }, trace)).status).toBe('not_recorded');
    expect(gateway.custodySetup.recover).toHaveBeenCalledExactlyOnceWith(token, rid, { kind: 'cancel', key }, trace);
  });
  it('dispatches every remaining method with exact inputs and preserves only verified safe errors', async () => {
    const fail = new DomainError('NOT_FOUND', 404, 'PRIVATE_SENTINEL');
    const challenge = { schemaVersion: 1, key, expectedSetupVersion: 1, expectedSetupHash: hash };
    const prepare = { schemaVersion: 1, key, previousDraft: null, ownerWalletPublicKey: '5UaivPxV8oQypy5mxmQCzvZXHVSMkPsZ2TKJvszyebVG',
      reviewedSpecificationRef: { id: uuid, version: 1, recordHash: hash }, expectedScope: { responsibilityVersion: 1, responsibilityHash: hash,
        siteGeneration: 0, siteRecordHash: hash, canonicalGeneration: 0, canonicalHash: hash } };
    const commands = [
      ['prepare', '', prepare], ['challenge', `/${uuid}/owner-challenge`, challenge],
      ['confirmation', `/${uuid}/owner-confirmation-challenge`, { ...challenge, confirmationKey: 'confirmation_key_001', challengeId: uuid, challengeHash: hash, walletSignature: Buffer.alloc(64, 1).toString('base64') }],
      ['confirm', `/${uuid}/confirm-owner`, { ...challenge, challengeId: uuid, challengeHash: hash, confirmationId: uuid, confirmationNonce: 'A'.repeat(43), walletSignature: Buffer.alloc(64, 1).toString('base64') }],
      ['cancel', `/${uuid}/cancel`, { ...challenge, expectedSetupControlGeneration: 0 }],
    ] as const;
    for (const [kind, suffix, command] of commands) {
      gateway.custodySetup[kind].mockRejectedValue(fail);
      const g = adapter(`/v1/responsibilities/${rid}/custody-setups${suffix}`, 'POST', key).custodySetup;
      const pending = kind === 'prepare' ? g.prepare(token, rid, command, trace) : g[kind](token, rid, uuid, command, trace);
      await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Resource not found.' });
      expect(gateway.custodySetup[kind]).toHaveBeenCalledExactlyOnceWith(token, rid, ...(kind === 'prepare' ? [] : [uuid]), command, trace);
    }
    gateway.custodySetup.get.mockRejectedValue(fail);
    await expect(adapter(`/v1/responsibilities/${rid}/custody-setups/${uuid}`).custodySetup.get(token, rid, uuid, trace)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    gateway.financialPolicy.context.mockRejectedValue(fail); gateway.financialPolicy.get.mockRejectedValue(fail); gateway.financialPolicy.recover.mockRejectedValue(fail);
    await expect(adapter(`/v1/responsibilities/${rid}/financial-policies/context?assetKey=${hash}`).financialPolicy.context(token, rid, hash)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(adapter(`/v1/responsibilities/${rid}/financial-policy-documents/${id}/versions/1`).financialPolicy.get(token, { kind: 'document', id, version: 1, responsibilityId: rid })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(adapter(`/v1/financial-governance/operations/${key}?kind=save_document&targetId=${id}&requestHash=${hash}`).financialPolicy.recover(token, { kind: 'save_document', key, targetId: id, responsibilityId: null, publicRequestHash: hash })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it.each(['?limit=20&limit=20', '?%6cimit=20', '?limit=020', '?limit=21', '?afterId=wrong', '?extra=1', '?'])('rejects mismatched/aliased index query %s before dispatch', suffix => {
    const fetch = vi.fn(privateFetch);
    return expect(adapter(`/v1/financial-governance${suffix}`, 'GET', null, fetch).financialPolicy.index(token, null, { afterId: null, limit: 20 })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' }).then(() => expect(fetch).not.toHaveBeenCalled());
  });
  it('rejects token, scope, method, key, future authority and caller evidence substitutions before dispatch', async () => {
    const fetch = vi.fn(privateFetch);
    await expect(adapter(undefined, undefined, undefined, fetch).financialPolicy.index('different', null, { afterId: null, limit: 20 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(adapter(write.route, 'GET', key, fetch).financialPolicyWrite.submit(token, write)).rejects.toThrow();
    await expect(adapter(write.route, 'POST', 'changed_request_0001', fetch).financialPolicyWrite.submit(token, write)).rejects.toThrow();
    await expect(adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, { ...write, evidence: {} } as never)).rejects.toThrow();
    await expect(adapter('/v1/financial-governance-preparation', 'POST', key, fetch).financialPolicyPreparation.prepare(token, null, selection)).rejects.toThrow();
    await expect(adapter('/v1/financial-governance-preparation', 'POST', null, fetch).financialPolicyPreparation.prepare(token, rid, selection)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects tampering of all transport bindings, freshness, status and policy result scope', async () => {
    const changes: ((d: any) => void)[] = [d => { d.nonce = crypto.randomUUID(); }, d => { d.tokenHash = 'f'.repeat(64); },
      d => { d.requestHash = 'f'.repeat(64); }, d => { d.actionHash = 'f'.repeat(64); }, d => { d.request.url += '/other'; },
      d => { d.request.method = 'POST'; }, d => { d.request.correlationId = 'other'; }, d => { d.issuer = 'https://other.example'; },
      d => { d.environment = 'production'; }, d => { d.respondedAt = new Date(Date.now() - 60_000).toISOString(); },
      d => { d.respondedAt = new Date(Date.now() + 60_000).toISOString(); }, d => { d.identity = { actor: 'forged' }; },
      d => { d.outcome.data.scope.environment = 'production'; }, d => { d.outcome.data.financialState = 'CONFIRMED'; },
      d => { d.outcome.data.observation.expiresAt = new Date(Date.now() - 1).toISOString(); }];
    for (const change of changes) {
      const fetch = vi.fn(async (request: Request) => { const data = await (await privateFetch(request)).json(); change(data); return Response.json(data, { headers }); });
      await expect(adapter(undefined, undefined, undefined, fetch).financialPolicy.index(token, null, { afterId: null, limit: 20 })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' }); expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('requires exact success/error status, private caching and action-family errors', async () => {
    for (const change of [
      (d: any) => new Response(JSON.stringify(d), { status: 201, headers }),
      (d: any) => Response.json(d, { headers: { 'Cache-Control': 'public' } }),
      (d: any) => Response.json({ ...d, outcome: { status: 'error', code: 'NOT_FOUND' } }, { status: 503, headers }),
      (d: any) => Response.json({ ...d, outcome: { status: 'error', code: 'CUSTODY_SCOPE_CHANGED' } }, { status: 409, headers }),
    ]) {
      const fetch = vi.fn(async (request: Request) => change(await (await privateFetch(request)).json()));
      await expect(adapter(undefined, undefined, undefined, fetch).financialPolicy.index(token, null, { afterId: null, limit: 20 }))
        .rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' }); expect(fetch).toHaveBeenCalledOnce();
    }
    gateway.financialPolicy.index.mockRejectedValue(new DomainError('NOT_FOUND', 409, 'PRIVATE_SENTINEL'));
    await expect(adapter().financialPolicy.index(token, null, { afterId: null, limit: 20 })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
  });
  it('does not let a self-consistent receipt for another request become this command result', async () => {
    const fetch = async (request: Request) => { const d = await (await privateFetch(request)).json();
      d.outcome.data.receipt.record.text = 'Replaced policy'; d.outcome.data.receipt.record.contentHash = await financialPolicyTextHash('Replaced policy');
      return Response.json(d, { headers }); };
    await expect(adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, write)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
  });
  it('captures the original headers and command before a service await', async () => {
    const request = original(write.route, 'POST', key), command = structuredClone(write);
    let release!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const fetch = async (forwarded: Request) => { entered(); await hold; return privateFetch(forwarded); };
    const g = serviceFinancialGateways({ fetch }, request, issuer), pending = g.financialPolicyWrite.submit(token, command);
    await started; request.headers.set('Authorization', 'Bearer changed'); request.headers.set('Idempotency-Key', 'changed_key_0001'); command.input.text = 'changed'; release();
    expect((await pending).receipt.record).toMatchObject({ text: 'Exact reviewed policy.' });
    expect(gateway.financialPolicyWrite.submit).toHaveBeenCalledExactlyOnceWith(token, write);
  });
  it('never retries unknown, redirecting, malformed, oversized or stream-failed results', async () => {
    const responses = [() => Response.redirect('https://untrusted.example', 307), () => new Response('bad JSON', { headers }),
      () => new Response('x'.repeat(financialResponseBytes + 1), { headers }), () => new Response(new ReadableStream({ start(c) { c.error(new Error('PRIVATE_SENTINEL')); } }), { headers })];
    for (const respond of responses) {
      const fetch = vi.fn(async () => respond());
      await expect(adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, write)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' }); expect(fetch).toHaveBeenCalledOnce();
    }
    gateway.financialPolicyWrite.submit.mockRejectedValue(new Error('PRIVATE_SENTINEL'));
    const fetch = vi.fn(privateFetch);
    await expect(adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, write)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce(); expect(gateway.financialPolicyWrite.submit).toHaveBeenCalledOnce();
  });
  it('bounds intake and rejects unsupported private routes before constructing gateways', async () => {
    expect((await privateFetch(new Request(financialUrl))).status).toBe(404);
    expect((await privateFetch(new Request(financialUrl, { method: 'POST' }))).status).toBe(401);
    const good = input({ kind: 'policy-index', responsibilityId: null, query: { afterId: null, limit: 20 } });
    for (const request of [privateRequest({ ...good, evidence: {} }), privateRequest({ padding: 'x'.repeat(financialRequestBytes) }), privateRequest(good, { 'Content-Length': String(financialRequestBytes + 1) }),
      privateRequest(good, { 'Content-Encoding': 'gzip' }), privateRequest({ ...good, request: { ...good.request, url: 'https://api.example/other' } })]) {
      expect((await privateFetch(request)).status).toBe(422);
    }
    expect(factory).not.toHaveBeenCalled();
  });
  it('terminates stalled intake and service waits, preserving unknown outcome without retry', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel });
    const req = new Request(financialUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    const pending = privateFetch(req); await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe(422); expect(cancel).toHaveBeenCalledOnce(); expect(factory).not.toHaveBeenCalled();
    const fetch = vi.fn(async () => new Promise<Response>(() => {}));
    const result = adapter(write.route, 'POST', key, fetch).financialPolicyWrite.submit(token, write);
    const rejected = expect(result).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    // Digest work uses real WebCrypto scheduling before the request deadline begins.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(20_001); await rejected;
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps the public transport and response validators free of privileged runtime imports', () => {
    for (const name of ['worker-financial.ts', 'financial-worker-result.ts', 'financial-worker-closure-result.ts']) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      expect(source).not.toMatch(/import\s+(?!type\b)[^;]*from ['"](?:@pactwoven\/db|\.\/(?:.*verifier|auth|.*development|financial-policy.*-service|custody-setup-service)\.js)['"]/s);
    }
  });
});
