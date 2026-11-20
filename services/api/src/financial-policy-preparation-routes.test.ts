import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialPolicyPreparationResponseSchema, type FinancialPolicyPreparationRequest, type FinancialPolicyPreparationResponse } from '@pactwoven/contracts';
import { DomainError, commandDigest, financialPolicyTextHash } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import { registerFinancialPolicyPreparationRoutes } from './financial-policy-preparation-routes.js';
import { readFinancialPolicyWriteJson } from './financial-policy-write-routes.js';
import type { FinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';

vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('Database construction forbidden in source-only route tests.'); } } }));
const rid = 'responsibility_a', token = 'synthetic.preparation.token', hash = 'a'.repeat(64);
const orgPath = '/v1/financial-governance-preparation', path = `/v1/responsibilities/${rid}/financial-policy-preparation`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const ref = (id: string, version = 1) => ({ id, version, recordHash: hash });
const body: Extract<FinancialPolicyPreparationRequest, { action: 'save_document' }> = { schemaVersion: 1, action: 'save_document', targetId: 'mandate_doc', previous: null, purpose: 'financial_mandate' };
const encoded = (text: string) => new TextEncoder().encode(text);
function request(input: string | Uint8Array | ReadableStream<Uint8Array>, options: { path?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return new Request(`http://localhost${options.path ?? path}`, { method: 'POST', headers: options.headers ?? headers, body: input,
    duplex: 'half', ...(options.signal ? { signal: options.signal } : {}) } as RequestInit);
}
function stream(chunks: Uint8Array[], cancel?: () => void) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); }, ...(cancel ? { cancel } : {}) });
}
async function fixture(configured = true) {
  const now = Date.now(), instant = (offset: number) => new Date(now + offset).toISOString();
  const authority = { schemaVersion: 1, responsibility: { id: rid, version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
    record: { ...authority, environment: 'development', organizationId: 'org_a' } }), site: { id: 'site_a', generation: 0, recordHash: hash } };
  const samples: { path: string; selection: FinancialPolicyPreparationRequest }[] = [
    { path, selection: body },
    { path: orgPath, selection: { ...body, purpose: 'budget_policy' } },
    { path: orgPath, selection: { ...body, purpose: 'approval_policy' } },
    { path, selection: { schemaVersion: 1, action: 'save_draft', targetId: 'draft_a', previous: null, document: null } },
    { path, selection: { schemaVersion: 1, action: 'withdraw_draft', targetId: 'draft_a', previous: ref('draft_a') } },
    { path: orgPath, selection: { schemaVersion: 1, action: 'propose_governance', targetId: 'proposal_a', previous: null,
      assetKey: null, budgetDocument: null, approvalDocument: null } },
  ];
  function response(responsibilityId: string | null, selection: FinancialPolicyPreparationRequest): FinancialPolicyPreparationResponse {
    const action = selection.action;
    const material = action === 'save_document' ? { action, purpose: selection.purpose, organizationEpoch: 2,
      draftScope: responsibilityId === null ? null : draftScope, siteActive: responsibilityId === null ? null : true } :
      action === 'save_draft' ? { action, profile: 'incomplete', draftScope, siteActive: true, document: null, asset: null, account: null, governance: null, trust: null } :
      action === 'withdraw_draft' ? { action } : { action, asset: null, budgetAccountId: null, control: null, acceptedConfiguration: null,
        periods: [], budgetDocument: null, approvalDocument: null, eligibleActionSites: [] };
    const reasons = ['PREDECESSOR_CHANGED', ...(action === 'save_draft' ? [selection.document === null ? 'DOCUMENT_REQUIRED' : 'DOCUMENT_CHANGED'] :
      action === 'propose_governance' ? ['ASSET_MISSING', 'DOCUMENT_REQUIRED', 'SITE_ACCESS_REQUIRED'] : [])].sort();
    return FinancialPolicyPreparationResponseSchema.parse({ schemaVersion: 1, responsibilityId, selection,
      scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2,
        roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] }, observation: { observedAt: instant(-1000), expiresAt: instant(19_000) },
      target: { state: 'changed', latestReference: ref(selection.targetId, (selection.previous?.version ?? 0) + 1), record: null, historicalDocuments: [] },
      decision: { action, state: 'blocked', reasons, requiredAuthentication: null }, material,
      configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'], effectiveAuthority: false, financialState: null });
  }
  const gateway = { prepare: vi.fn(async (_token: string, responsibilityId: string | null, selection: FinancialPolicyPreparationRequest): Promise<unknown> => response(responsibilityId, selection)) };
  const app = new Hono<ApiEnv>(); app.use('*', async (c, next) => { c.set('correlationId', 'preparation_correlation'); await next(); });
  registerFinancialPolicyPreparationRoutes(app, configured ? gateway as FinancialPolicyPreparationGateway : undefined);
  const generic = vi.fn(); app.use('*', async (_c, next) => { generic(); await next(); });
  return { app, gateway, generic, samples, response, draftScope, instant };
}
function secure(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}
afterEach(() => vi.useRealTimers());

describe('strict metadata-only preparation routes with an offline synthetic gateway', () => {
  it('registers only the two exact preparation families and dispatches all supported action/purpose selections once', async () => {
    const f = await fixture();
    expect(f.app.routes.filter(r => !r.path.includes('*')).map(r => r.path)).toEqual([orgPath, '/v1/responsibilities/:id/financial-policy-preparation']);
    for (const sample of f.samples) {
      const result = await f.app.fetch(request(JSON.stringify(sample.selection), { path: sample.path }));
      expect(result.status).toBe(200); secure(result);
      expect(f.gateway.prepare.mock.calls.at(-1)).toEqual([token, sample.path === orgPath ? null : rid, sample.selection]);
      expect((await result.json()).decision.state).toBe('blocked');
    }
    expect(f.gateway.prepare).toHaveBeenCalledTimes(6); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('rejects unsupported %s before consuming a body or observing identity', async method => {
    const f = await fixture(), result = await f.app.request(path, { method, headers });
    expect(result.status).toBe(404); secure(result); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it('allows the existing shared origin OPTIONS handler to finish before preparation registration', async () => {
    const f = await fixture(), app = new Hono<ApiEnv>();
    app.use('*', async (c, next) => c.req.method === 'OPTIONS' && c.req.header('Origin') === 'https://preview.invalid' ? c.body(null, 204) : next());
    registerFinancialPolicyPreparationRoutes(app, f.gateway as FinancialPolicyPreparationGateway);
    expect((await app.request(path, { method: 'OPTIONS', headers: { Origin: 'https://preview.invalid' } })).status).toBe(204);
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([path + '?', path + '?assetKey=x', path + '#fragment', path + '/', path + '//', path + '/preview', orgPath + '-alias',
    path.replace('/v1/', '/v%31/'), path.replace('/responsibilities/', '//responsibilities/'), path.replace(rid, '%72esponsibility_a'),
    path.replace('financial-policy-preparation', '%66inancial-policy-preparation'), path.replace('financial-policy-preparation', '%2566inancial-policy-preparation'),
    orgPath + '/submit', orgPath + ';alias', orgPath + '_alias', '//v1/financial-governance-preparation',
    path.replace(rid, '%zz').replace('financial-policy-preparation', '%66inancial-policy-preparation'),
    path.replace('financial-policy-preparation', '%25%36%36inancial-policy-preparation')])('rejects route/query/encoding alias %s without generic fallback', async url => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify(body), { path: url }));
    expect(result.status).toBe(422); secure(result); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['', 'arbitrary_key', 'original_key_12345'])('forbids Idempotency-Key even when its value is %j', async value => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify(body), { headers: { ...headers, 'Idempotency-Key': value } }));
    expect(result.status).toBe(422); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([path + '#', path + '?#', orgPath + '#', orgPath + '?#'])('rejects an empty query or fragment marker at %s', async url => {
    const f = await fixture(), selection = { ...body, purpose: url.startsWith(orgPath) ? 'budget_policy' : 'financial_mandate' };
    const result = await f.app.fetch(request(JSON.stringify(selection), { path: url }));
    expect(result.status).toBe(422); secure(result); expect(f.gateway.prepare).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['environment', 'organizationId', 'actor', 'roles', 'session', 'scope', 'key', 'publicRequestHash', 'identityEvidenceId', 'factor', 'nonce', 'text', 'draft', 'bundle', 'expiresAt', 'qualified'])
  ('rejects unknown/private body field %s', async key => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify({ ...body, [key]: 'forged' })));
    expect(result.status).toBe(422); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each(['', 'Basic x', 'Bearer ', 'bearer a', 'Bearer a b', `Bearer ${'a'.repeat(8193)}`].map((authorization, index) => ({ authorization, index })))('requires exact bounded bearer syntax case $index', async ({ authorization }) => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify(body), { headers: { ...headers, Authorization: authorization } }));
    expect(result.status).toBe(401); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('rejects wrong route/action purposes and unsupported actions before calling the gateway', async () => {
    const f = await fixture();
    for (const selection of [{ ...body, purpose: 'budget_policy' }, { ...body, action: 'accept_governance' }, { ...body, targetId: 'bad/id' },
      { schemaVersion: 1, action: 'withdraw_draft', targetId: 'draft_a', previous: null }]) {
      expect((await f.app.fetch(request(JSON.stringify(selection)))).status).toBe(422);
    }
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('returns fixed setup-required without generic authentication fallback', async () => {
    const f = await fixture(false), result = await f.app.fetch(request(JSON.stringify(body)));
    expect(result.status).toBe(503); expect((await result.json()).error.code).toBe('SETUP_REQUIRED'); expect(f.generic).not.toHaveBeenCalled();
  });
  it('captures the gateway method, bearer and route before a slow body and keeps expected selection independent', async () => {
    const f = await fixture(), original = f.gateway.prepare;
    f.gateway.prepare = vi.fn(async () => { throw new Error('replacement'); });
    original.mockImplementation(async (_token, responsibilityId, selection) => {
      const result = f.response(responsibilityId, selection); selection.targetId = 'changed'; return result;
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const raw = request(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
    const pending = f.app.fetch(raw); for (let i = 0; i < 20 && !raw.body!.locked; i++) await Promise.resolve();
    expect(raw.body!.locked).toBe(true); raw.headers.set('Authorization', 'Bearer changed');
    controller.enqueue(encoded(JSON.stringify(body))); controller.close();
    expect((await pending).status).toBe(200); expect(original.mock.calls[0]?.[0]).toBe(token); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each(['selection', 'scope', 'private', 'future', 'expired', 'decision', 'authority'])('rejects malformed/unbound returned %s with fixed safe failure', async mode => {
    const f = await fixture(); f.gateway.prepare.mockImplementation(async (_token, responsibilityId, selection) => {
      const result = f.response(responsibilityId, selection);
      if (mode === 'selection') result.selection.targetId = 'different';
      if (mode === 'scope') result.responsibilityId = null;
      if (mode === 'private') Object.assign(result, { identityEvidence: 'secret' });
      if (mode === 'future') result.observation = { observedAt: f.instant(1_000), expiresAt: f.instant(2_000) };
      if (mode === 'expired') result.observation = { observedAt: f.instant(-2_000), expiresAt: f.instant(-1_000) };
      if (mode === 'decision') result.decision.state = 'reviewable';
      if (mode === 'authority' && result.material.action === 'save_document' && result.material.draftScope) result.material.draftScope.authorityHash = hash;
      return result;
    });
    const result = await f.app.fetch(request(JSON.stringify(body))); expect(result.status).toBe(503); secure(result);
    expect((await result.json()).error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
  });
  it('checks returned full document text hash before returning exact preparation', async () => {
    const f = await fixture(), selection = { ...body, previous: ref(body.targetId) }, text = 'Exact original terms.';
    f.gateway.prepare.mockImplementation(async (_token, responsibilityId, input) => {
      const result = f.response(responsibilityId, input);
      result.target = { state: 'exact', latestReference: selection.previous, historicalDocuments: [], record: {
        reference: selection.previous, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: rid,
          id: body.targetId, version: 1, predecessor: null, actor: { actorId: 'actor_a', membershipVersion: 1 }, organizationEpoch: 1,
          operationId: '00000000-0000-0000-0000-000000000001', createdAt: f.instant(-50_000), kind: 'document', purpose: 'financial_mandate', text: text + ' tampered',
          contentHash: await financialPolicyTextHash(text) }, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null } };
      result.decision = { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null }; return result;
    });
    expect((await f.app.fetch(request(JSON.stringify(selection)))).status).toBe(503);
  });
  it.each([new Error('secret database host'), new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 503, 'private actor subject'), { code: 'AUTH_REQUIRED', message: 'forged' }])
  ('scrubs injected failures %j', async error => {
    const f = await fixture(); f.gateway.prepare.mockRejectedValue(error);
    const result = await f.app.fetch(request(JSON.stringify(body))), text = await result.text();
    expect([409, 503]).toContain(result.status); expect(text).not.toMatch(/secret|private actor|forged/); secure(result);
  });

  it('accepts exactly 8 KiB including whitespace with exact framing', async () => {
    const f = await fixture(), json = JSON.stringify(body), exact = json + ' '.repeat(8192 - encoded(json).byteLength);
    expect((await f.app.fetch(request(stream([encoded(exact.slice(0, 70)), encoded(exact.slice(70))]),
      { headers: { ...headers, 'Content-Length': '8192' } }))).status).toBe(200);
    expect(f.gateway.prepare).toHaveBeenCalledOnce();
  });
  it('reuses the reader with split multibyte UTF-8 and chunked framing', async () => {
    const json = JSON.stringify({ text: 'Café 🧵' }), bytes = encoded(json), chunks = [...bytes].map(byte => new Uint8Array([byte]));
    await expect(readFinancialPolicyWriteJson(request(stream(chunks), { headers: { ...headers, 'Transfer-Encoding': 'chunked' } }), 8192)).resolves.toEqual({ text: 'Café 🧵' });
  });
  it.each(['declared', 'streamed'])('rejects %s byte overflow before observing identity', async mode => {
    const f = await fixture(), json = JSON.stringify(body) + ' '.repeat(8193);
    const result = await f.app.fetch(request(mode === 'declared' ? JSON.stringify(body) : stream([encoded(json)]),
      { headers: mode === 'declared' ? { ...headers, 'Content-Length': '8193' } : headers }));
    expect(result.status).toBe(413); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' },
  ])('rejects media/encoding %j', async changed => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify(body), { headers: { ...headers, ...changed } }));
    expect(result.status).toBe(415); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { 'Content-Length': '01' }, { 'Content-Length': '-1' }, { 'Content-Length': '2' }, { 'Content-Length': '0' },
    { 'Content-Length': '9007199254740992' }, { 'Transfer-Encoding': 'gzip' }, { 'Transfer-Encoding': 'chunked', 'Content-Length': '1' },
  ])('rejects ambiguous/mismatched framing %j', async changed => {
    const f = await fixture(), result = await f.app.fetch(request(JSON.stringify(body), { headers: { ...headers, ...changed } }));
    expect(result.status).toBe(422); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1}', '{"schemaVersion":1,"\\u0073chemaVersion":1}',
    '{"previous":{"id":"a","\\u0069d":"b"}}', '[]', 'null', '1', '{} trailing', '{"x":1e999}', '{"x":01}', '{"x":"\u0000"}',
    '{"x":' + '['.repeat(14) + '0' + ']'.repeat(14) + '}', '{"x":[' + Array(101).fill('0').join(',') + ']}',
    '{' + Array.from({ length: 33 }, (_, i) => `"k${i}":0`).join(',') + '}', '{"' + 'x'.repeat(129) + '":0}',
  ])('rejects duplicate decoded keys and bounded JSON structure %s', async json => {
    const f = await fixture(), result = await f.app.fetch(request(json)); expect(result.status).toBe(422); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it.each([{ bytes: [0xff] }, { bytes: [0xc3] }, { bytes: [0xed, 0xa0, 0x80] }])('rejects fatal/truncated UTF-8 bytes $bytes', async ({ bytes }) => {
    const f = await fixture(), result = await f.app.fetch(request(stream([encoded('{"x":"'), new Uint8Array(bytes), encoded('"}')])));
    expect(result.status).toBe(422); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('enforces one absolute 5s deadline across drip-fed chunks and cancels the reader', async () => {
    vi.useFakeTimers(); const f = await fixture(), cancel = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const raw = request(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel })), pending = f.app.fetch(raw);
    for (let i = 0; i < 20 && !raw.body!.locked; i++) await Promise.resolve();
    controller.enqueue(encoded('{')); await vi.advanceTimersByTimeAsync(4_000); controller.enqueue(encoded(' ')); await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending; expect(result.status).toBe(408); expect(cancel).toHaveBeenCalledOnce(); expect(raw.body!.locked).toBe(false);
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('cancels an aborted body and never calls the gateway', async () => {
    const f = await fixture(), cancel = vi.fn(), abort = new AbortController();
    const raw = request(new ReadableStream<Uint8Array>({ cancel }), { signal: abort.signal }), pending = f.app.fetch(raw);
    for (let i = 0; i < 20 && !raw.body!.locked; i++) await Promise.resolve();
    abort.abort(); const result = await pending; expect(result.status).toBe(408); expect(cancel).toHaveBeenCalledOnce(); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('rejects an already consumed or locked request without gateway work', async () => {
    const f = await fixture(), used = request(JSON.stringify(body)); await used.text();
    expect((await f.app.fetch(used)).status).toBe(503);
    const locked = request(JSON.stringify(body)), reader = locked.body!.getReader();
    expect((await f.app.fetch(locked)).status).toBe(503); reader.releaseLock();
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it('leaves unrelated routes for their existing handlers', async () => {
    const f = await fixture(); expect((await f.app.request('/v1/financial-governance/context')).status).toBe(404);
    expect(f.generic).toHaveBeenCalledOnce(); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
});
