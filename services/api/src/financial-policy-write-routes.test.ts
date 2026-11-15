import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, FinancialPolicyHttpMutationResponseSchema, type FinancialPolicyHttpRequest } from '@pactwoven/contracts';
import { DomainError, commandDigest, financialPolicyHttpRequestHash, physicalAssetKey, financialBudgetAccountId, financialBudgetPeriodId } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';
import { registerFinancialPolicyRoutes } from './financial-policy-routes.js';
import type { FinancialPolicyGateway } from './financial-policy-service.js';
import { registerFinancialPolicyWriteRoutes, readFinancialPolicyWriteJson, financialPolicyWriteBodyLimits } from './financial-policy-write-routes.js';
import type { FinancialPolicyWriteGateway, FinancialPolicyWriteRequest } from './financial-policy-write-service.js';

const token = 'synthetic.write.token', key = 'original_write_key_12345', hash = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' };
const ref = (id: string) => ({ id, version: 1, recordHash: hash });
const bodyBase = { schemaVersion: 1, organizationEpoch: 2, previous: null };
const docPath = '/v1/responsibilities/responsibility_a/financial-policy-documents/mandate_doc';
function request(text: string | Uint8Array | ReadableStream<Uint8Array>, options: { path?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return new Request(`http://localhost${options.path ?? docPath}`, { method: 'POST', body: text, duplex: 'half',
    headers: options.headers ?? headers, ...(options.signal ? { signal: options.signal } : {}) } as RequestInit);
}
const encoded = (text: string) => new TextEncoder().encode(text);
function stream(chunks: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }); }
async function fixture(configured = true) {
  const now = Date.now(), instant = (offset: number) => new Date(now + offset).toISOString();
  const basis = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draft = { scope: { authority: basis, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...basis, environment: 'development', organizationId: 'org_a' } }),
    site: { id: 'site_a', generation: 0, recordHash: hash } },
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark', supplier: null, acceptedTerms: null,
      payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...ref('mandate_doc'), purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null, startsAt: instant(-60_000), expiresAt: instant(300_000) };
  const asset = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: hash, financialUseEpoch: 0 };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key), control = { budgetAccountId, generation: 0, accepted: null };
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, instant(-60_000), instant(600_000)), startsAt: instant(-60_000), endsAt: instant(600_000) },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal',
      thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...ref('approval_doc'), purpose: 'approval_policy' }, { ...ref('budget_doc'), purpose: 'budget_policy' }] };
  const samples = [
    { path: docPath, body: { ...bodyBase, purpose: 'financial_mandate', text: 'Exact mandate. Café 🧵' }, kind: 'save_document' },
    { path: '/v1/financial-governance/documents/budget_doc', body: { ...bodyBase, purpose: 'budget_policy', text: 'Exact budget.' }, kind: 'save_document' },
    { path: '/v1/responsibilities/responsibility_a/financial-policies/draft_a', body: { ...bodyBase, draft }, kind: 'save_draft' },
    { path: '/v1/responsibilities/responsibility_a/financial-policies/draft_a/withdraw', body: { ...bodyBase, previous: ref('draft_a') }, kind: 'withdraw_draft' },
    { path: '/v1/financial-governance/proposal_a', body: { ...bodyBase, bundle, expectedControl: control, expiresAt: instant(300_000) }, kind: 'propose_governance' },
  ];
  async function receipt(input: FinancialPolicyWriteRequest) {
    const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2,
      roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] }, person = { actorId: 'actor_a', membershipVersion: 1 };
    const common = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: input.responsibilityId,
      id: input.id, version: (input.input.previous?.version ?? 0) + 1, predecessor: input.input.previous, actor: person, organizationEpoch: input.input.organizationEpoch,
      operationId: '00000000-0000-0000-0000-000000000001', createdAt: instant(-60_000) };
    const record = input.kind === 'save_document' ? { ...common, kind: 'document', purpose: input.input.purpose, text: input.input.text, contentHash: hash } :
      input.kind === 'save_draft' ? { ...common, kind: 'draft', state: 'DRAFT', requester: person, draft: input.input.draft } :
      input.kind === 'withdraw_draft' ? { ...common, kind: 'draft', state: 'WITHDRAWN', requester: person, draft } :
      { ...common, kind: 'governance', state: 'OPEN', proposer: person, bundle: input.input.bundle, expectedControl: input.input.expectedControl, expiresAt: input.input.expiresAt };
    return FinancialPolicyHttpMutationResponseSchema.parse({ schemaVersion: 1, scope, observation: { observedAt: instant(-1000), expiresAt: instant(19_000) },
      status: 'recorded', effectiveAuthority: false, financialState: null,
      receipt: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor: person, responsibilityId: input.responsibilityId,
        operationId: common.operationId, kind: input.kind, key: input.key, publicRequestHash: await financialPolicyHttpRequestHash({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a' }, input),
        target: { id: input.id, version: common.version, recordHash: hash }, record, effectiveAuthority: false, financialState: null } });
  }
  const gateway = { submit: vi.fn(async (_token: string, input: FinancialPolicyWriteRequest): Promise<unknown> => receipt(input)) };
  const app = new Hono<ApiEnv>(); app.use('*', async (c, next) => { c.set('correlationId', 'write_correlation'); await next(); });
  registerFinancialPolicyWriteRoutes(app, configured ? gateway as unknown as FinancialPolicyWriteGateway : undefined);
  const reject = () => vi.fn(async () => { throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'synthetic read'); });
  const read: FinancialPolicyGateway = { context: reject(), index: reject(), get: reject(), recover: reject() };
  registerFinancialPolicyRoutes(app, read);
  const generic = vi.fn(); app.use('*', async (_c, next) => { generic(); await next(); });
  return { app, gateway, read, generic, samples, receipt, draft, bundle, control };
}
function secure(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}
afterEach(() => vi.useRealTimers());

describe('financial-policy bounded write routes with a synthetic gateway', () => {
  it('registers five writers without changing ten accepted read endpoint registrations', async () => {
    const f = await fixture(), routes = f.app.routes.filter(route => !route.path.includes('*'));
    expect(routes).toHaveLength(15); expect(routes.slice(0, 5).every(route => route.method === 'ALL')).toBe(true);
    expect(routes[0]?.path).toBe('/v1/financial-governance/documents/:documentId');
    expect(routes[2]?.path.endsWith('/withdraw')).toBe(true);
  });
  it('dispatches each canonical writer as one immutable snapshot and returns confirmed HTTP 200', async () => {
    const f = await fixture();
    for (const sample of f.samples) {
      const response = await f.app.fetch(request(JSON.stringify(sample.body), { path: sample.path })); secure(response); expect(response.status).toBe(200);
      const call = f.gateway.submit.mock.calls.at(-1)!; expect(call[0]).toBe(token); expect(call[1]).toMatchObject({ route: sample.path, key, kind: sample.kind, input: sample.body });
      expect((await response.json()).receipt.publicRequestHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(f.gateway.submit).toHaveBeenCalledTimes(5); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('rejects unsupported %s for a writer before body or gateway work', async method => {
    const f = await fixture(), response = await f.app.request(docPath, { method, headers });
    expect(response.status).toBe(404); secure(response); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each([
    ['/v1/financial-governance/context', 'context'], ['/v1/financial-governance', 'index'],
    ['/v1/financial-governance/proposal_a/versions/1', 'get'], ['/v1/financial-governance/documents/budget_doc/versions/1', 'get'],
    ['/v1/responsibilities/responsibility_a/financial-policies/context', 'context'], ['/v1/responsibilities/responsibility_a/financial-policies', 'index'],
    ['/v1/responsibilities/responsibility_a/financial-policies/draft_a/versions/1', 'get'], ['/v1/responsibilities/responsibility_a/financial-policy-documents/mandate_doc/versions/1', 'get'],
    [`/v1/financial-governance/operations/${key}?kind=save_document&targetId=budget_doc&requestHash=${hash}`, 'recover'],
    [`/v1/responsibilities/responsibility_a/financial-policy-operations/${key}?kind=save_document&targetId=mandate_doc&requestHash=${hash}`, 'recover'],
  ] as const)('preserves the existing read handler for %s', async (path, method) => {
    const f = await fixture(), response = await f.app.request(path, { headers });
    expect(response.status).toBe(409); expect(f.read[method]).toHaveBeenCalledOnce(); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['/v1/financial-governance/context', '/v1/responsibilities/responsibility_a/financial-policies/context'])('preserves POST method rejection for reserved %s', async path => {
    const f = await fixture(), response = await f.app.request(path, { method: 'POST', headers, body: 'invalid body must not be read' });
    expect(response.status).toBe(404); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each([docPath + '?', docPath + '?actorId=other', docPath + '#fragment', docPath + '/', docPath.replace('mandate_doc', '%6dandate_doc'),
    docPath.replace('/v1/', '/v%31/'), docPath.replace('/responsibilities/', '//responsibilities/'),
    '/v1/financial-governance/%63ontext', '/v1/financial-governance/proposal_a/accept', '/v1/financial-governance/proposal_a/reject',
    '/v1/financial-governance/proposal_a/proposer-observation'])('rejects route/query alias or excluded action %s', async path => {
    const f = await fixture(), response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body), { path }));
    expect(response.status).toBe(422); secure(response); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });
  it.each(['actorId', 'environment', 'organizationId', 'roles', 'key', 'identityEvidenceId', 'mfaEvidenceId', 'nonce', 'verified'])('rejects public authority/unknown body field %s', async name => {
    const f = await fixture(), response = await f.app.fetch(request(JSON.stringify({ ...f.samples[0]!.body, [name]: 'forged' })));
    expect(response.status).toBe(422); expect(f.gateway.submit).not.toHaveBeenCalled();
  });
  it.each(['', 'short', 'contains spaces_1234'])('requires a canonical key header %s', async value => {
    const f = await fixture(), response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body), { headers: { ...headers, 'Idempotency-Key': value } }));
    expect(response.status).toBe(422); expect(f.gateway.submit).not.toHaveBeenCalled();
  });
  it.each(['', 'Basic abc', 'Bearer ', 'bearer wrong', 'Bearer a b'])('requires exact bearer syntax %s after structural parsing', async value => {
    const f = await fixture(), response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body), { headers: { ...headers, Authorization: value } }));
    expect(response.status).toBe(401); secure(response); expect(f.gateway.submit).not.toHaveBeenCalled();
  });
  it('returns setup required for an unconfigured writer without generic fallback', async () => {
    const f = await fixture(false), response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body)));
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('SETUP_REQUIRED'); secure(response); expect(f.generic).not.toHaveBeenCalled();
  });
  it('captures route/header identities before a slow body settles and captures gateway methods at registration', async () => {
    const f = await fixture(), originalSubmit = f.gateway.submit;
    f.gateway.submit = vi.fn(async () => { throw new Error('replacement'); });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const raw = request(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
    const pending = f.app.fetch(raw); for (let i = 0; i < 20 && !raw.body!.locked; i++) await Promise.resolve();
    expect(raw.body!.locked).toBe(true); raw.headers.set('Authorization', 'Bearer changed'); raw.headers.set('Idempotency-Key', 'changed_original_key');
    controller.enqueue(encoded(JSON.stringify(f.samples[0]!.body))); controller.close();
    expect((await pending).status).toBe(200); expect(originalSubmit.mock.calls[0]?.[0]).toBe(token); expect(originalSubmit.mock.calls[0]?.[1].key).toBe(key);
    expect(f.gateway.submit).not.toHaveBeenCalled();
  });
  it('keeps expected request immutable when a gateway mutates its received copy', async () => {
    const f = await fixture(); f.gateway.submit.mockImplementation(async (_token, input) => {
      const result = await f.receipt(input); input.key = 'changed_original_key'; if (input.kind === 'save_document') input.input.text = 'changed'; return result;
    });
    expect((await f.app.fetch(request(JSON.stringify(f.samples[0]!.body)))).status).toBe(200);
  });
  it.each(['private_field', 'text', 'digest', 'expired', 'future', 'key'])('rejects malformed/unbound response %s without success', async mode => {
    const f = await fixture(); f.gateway.submit.mockImplementation(async (_token, input) => {
      const result = await f.receipt(input);
      if (mode === 'private_field') return { ...result, privateEvidence: 'secret' };
      if (mode === 'text' && result.receipt.record.kind === 'document') result.receipt.record.text = 'substituted';
      if (mode === 'digest') result.receipt.publicRequestHash = 'f'.repeat(64);
      if (mode === 'key') result.receipt.key = 'other_original_key';
      if (mode === 'expired') result.observation = { observedAt: new Date(Date.now() - 30_000).toISOString(), expiresAt: new Date(Date.now() - 10_000).toISOString() };
      if (mode === 'future') result.observation = { observedAt: new Date(Date.now() + 1000).toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString() };
      return result;
    });
    const response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body))); expect(response.status).toBe(503); secure(response);
    expect((await response.json()).error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN'); expect(f.gateway.submit).toHaveBeenCalledOnce();
  });
  it('does not leak gateway/SQL messages and never submits again after an unknown failure', async () => {
    const f = await fixture(); f.gateway.submit.mockRejectedValue(new Error('private SQL token and full policy text'));
    const response = await f.app.fetch(request(JSON.stringify(f.samples[0]!.body))); expect(response.status).toBe(503); secure(response);
    expect(await response.json()).toEqual({ error: { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN',
      message: 'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.', correlationId: 'write_correlation' } });
    expect(f.gateway.submit).toHaveBeenCalledOnce();
  });
  it.each(['intact', 'substituted_scope', 'preflight_rejection'] as const)('classifies draft result validation separately from gateway preflight: %s', async mode => {
    const f = await fixture(), sample = f.samples[2]!;
    f.gateway.submit.mockImplementation(async (_token, input) => {
      if (mode === 'preflight_rejection') throw new DomainError('FINANCIAL_POLICY_INVALID', 422, 'private preflight material details');
      const result = await f.receipt(input);
      if (mode === 'substituted_scope') {
        result.scope.organizationId = 'other_org'; result.receipt.organizationId = 'other_org'; result.receipt.record.organizationId = 'other_org';
      }
      // This remains wire-schema-valid, but the reviewed draft's authority hash is bound to org_a.
      return FinancialPolicyHttpMutationResponseSchema.parse(result);
    });
    const response = await f.app.fetch(request(JSON.stringify(sample.body), { path: sample.path })); secure(response);
    expect(f.gateway.submit).toHaveBeenCalledOnce();
    if (mode === 'intact') expect(response.status).toBe(200);
    else {
      expect(response.status).toBe(mode === 'substituted_scope' ? 503 : 422);
      expect((await response.json()).error.code).toBe(mode === 'substituted_scope' ? 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' : 'FINANCIAL_POLICY_INVALID');
    }
  });
});

describe('financial-policy streaming, structural and Unicode body boundaries', () => {
  const limit = financialPolicyWriteBodyLimits.document;
  it.each(['raw', 'escaped'] as const)('accepts 20,000 astral codepoints represented as %s JSON within 256 KiB', async mode => {
    const f = await fixture(), text = '🧵'.repeat(20_000), body = { ...bodyBase, purpose: 'financial_mandate', text };
    const json = mode === 'raw' ? JSON.stringify(body) : JSON.stringify(body).replaceAll('🧵', '\\ud83e\\uddf5');
    expect(encoded(json).length).toBeLessThan(limit);
    const response = await f.app.fetch(request(json)); expect(response.status).toBe(200);
    expect(f.gateway.submit.mock.calls[0]?.[1]).toMatchObject({ input: { text } });
  });
  it.each(['too_many', 'decomposed', 'carriage_return', 'surrogate'])('rejects unsupported document text %s before gateway', async mode => {
    const f = await fixture(), text = mode === 'too_many' ? '🧵'.repeat(20_001) : mode === 'decomposed' ? 'Cafe\u0301' : mode === 'carriage_return' ? 'a\rb' : '\ud800';
    const response = await f.app.fetch(request(JSON.stringify({ ...bodyBase, purpose: 'financial_mandate', text })));
    expect(response.status).toBe(422); expect(f.gateway.submit).not.toHaveBeenCalled();
  });
  it('accepts an exact byte-boundary body and rejects one-byte/chunked overflow', async () => {
    const f = await fixture(), json = JSON.stringify(f.samples[0]!.body), size = encoded(json).length;
    expect((await f.app.fetch(request(json + ' '.repeat(limit - size)))).status).toBe(200);
    const before = f.gateway.submit.mock.calls.length;
    const overflow = await f.app.fetch(request(stream([encoded(json), encoded(' '.repeat(limit - size)), encoded(' ')]), { headers: { ...headers, 'Transfer-Encoding': 'chunked' } }));
    expect(overflow.status).toBe(413); secure(overflow); expect(f.gateway.submit).toHaveBeenCalledTimes(before);
  });
  it('applies independent draft/proposal and withdrawal byte caps', async () => {
    const f = await fixture();
    for (const index of [2, 3, 4]) {
      const sample = f.samples[index]!, maximum = index === 3 ? 8192 : 32768;
      const json = JSON.stringify(sample.body), bytes = encoded(json).length;
      expect((await f.app.fetch(request(json + ' '.repeat(maximum - bytes), { path: sample.path }))).status).toBe(200);
      expect((await f.app.fetch(request(json + ' '.repeat(maximum - bytes + 1), { path: sample.path }))).status).toBe(413);
    }
    expect(f.gateway.submit).toHaveBeenCalledTimes(3);
  });
  it('admits the maximum supported governance array and longest legal site IDs', async () => {
    const f = await fixture(), body = { ...bodyBase, bundle: structuredClone(f.bundle), expectedControl: f.control, expiresAt: f.draft.expiresAt };
    body.bundle.approval.actionSiteIds = Array.from({ length: 100 }, (_, index) => `site_${String(index).padStart(3, '0')}_${'a'.repeat(119)}`);
    expect(body.bundle.approval.actionSiteIds[0]!.length).toBe(128);
    const response = await f.app.fetch(request(JSON.stringify(body), { path: '/v1/financial-governance/proposal_a' })); expect(response.status).toBe(200);
  });
  it('decodes valid UTF-8 across single-byte chunk boundaries', async () => {
    const body = { ...bodyBase, purpose: 'financial_mandate', text: 'Café 🧵' }, bytes = encoded(JSON.stringify(body));
    expect(await readFinancialPolicyWriteJson(request(stream([...bytes].map(byte => Uint8Array.of(byte)))), limit)).toEqual(body);
  });
  it.each([Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0xed, 0xa0, 0x80)])('fatally rejects malformed/split UTF-8 %j', async bytes => {
    await expect(readFinancialPolicyWriteJson(request(stream([encoded('{"text":"'), bytes])), limit)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
  });
  it.each(['{"schemaVersion":1,"schemaVersion":1}', '{"schemaVersion":1,"\\u0073chemaVersion":1}', '{"a":{"text":1,"\\u0074ext":2}}',
    '{"a":true} trailing', '[]', 'null', '"text"', '{"a":1e999}', '{"a":01}', '{"a":"\\x"}', '{"a":"unterminated}', '{"a":false,}', '{"a":[1,]}'])
    ('rejects ambiguous/malformed JSON before schema parsing: %s', async json => {
      await expect(readFinancialPolicyWriteJson(request(json), limit)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    });
  it('enforces parser depth, values, object keys, array length and decoded key length at the frozen boundaries', async () => {
    const parse = (input: unknown) => readFinancialPolicyWriteJson(request(JSON.stringify(input)), limit);
    const nested = (count: number): unknown => count === 0 ? 0 : [nested(count - 1)];
    await expect(parse({ a: nested(11) })).resolves.toBeDefined(); await expect(parse({ a: nested(12) })).rejects.toBeDefined();
    await expect(parse(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`a${i}`, i])))).resolves.toBeDefined();
    await expect(parse(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, i])))).rejects.toBeDefined();
    await expect(parse({ a: Array(100).fill(0) })).resolves.toBeDefined(); await expect(parse({ a: Array(101).fill(0) })).rejects.toBeDefined();
    await expect(parse({ ['a'.repeat(128)]: 0 })).resolves.toBeDefined(); await expect(parse({ ['a'.repeat(129)]: 0 })).rejects.toBeDefined();
    const exact = { a: Array.from({ length: 10 }, () => ({ a: Array(100).fill(0) })), b: 0, c: 0 };
    await expect(parse(exact)).resolves.toBeDefined(); await expect(parse({ ...exact, d: 0 })).rejects.toBeDefined();
  });
  it.each([{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Type': 'application/json; charset=utf-8; charset=utf-8' },
    { 'Content-Type': 'application/json; profile=unsafe' }, { 'Content-Encoding': 'gzip' }, { 'Content-Encoding': 'br' }, { 'Content-Encoding': 'identity,gzip' }])
    ('rejects unsupported media/compression %j', async change => {
      await expect(readFinancialPolicyWriteJson(request('{}', { headers: { ...headers, ...change } }), limit)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    });
  it.each([{ 'Content-Length': '01' }, { 'Content-Length': '-1' }, { 'Content-Length': '2, 2' }, { 'Content-Length': '9007199254740992' },
    { 'Content-Length': '1' }, { 'Content-Length': '3' }, { 'Transfer-Encoding': 'chunked, chunked' }, { 'Transfer-Encoding': 'gzip' },
    { 'Content-Length': '2', 'Transfer-Encoding': 'chunked' }])('rejects ambiguous or mismatched framing %j', async change => {
      await expect(readFinancialPolicyWriteJson(request('{}', { headers: { ...headers, ...change } }), limit)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID', status: 422 });
    });
  it('accepts exact declared length and chunked identity encoding, but rejects advertised oversize', async () => {
    await expect(readFinancialPolicyWriteJson(request('{}', { headers: { ...headers, 'Content-Length': '2' } }), limit)).resolves.toEqual({});
    await expect(readFinancialPolicyWriteJson(request('{}', { headers: { ...headers, 'Transfer-Encoding': 'chunked', 'Content-Encoding': 'identity' } }), limit)).resolves.toEqual({});
    await expect(readFinancialPolicyWriteJson(request('{}', { headers: { ...headers, 'Content-Length': String(limit + 1) } }), limit)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
  });
  it('rejects consumed or locked bodies and unconfigured limits without accepting a generic parsed object', async () => {
    const used = request('{}'); await used.text(); await expect(readFinancialPolicyWriteJson(used, limit)).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    const locked = request('{}'), reader = locked.body!.getReader();
    await expect(readFinancialPolicyWriteJson(locked, limit)).rejects.toMatchObject({ code: 'SETUP_REQUIRED' }); reader.releaseLock();
    await expect(readFinancialPolicyWriteJson(request('{}'), 64 * 1024)).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
  });
  it('uses one absolute deadline across chunks and cancels without provider work', async () => {
    vi.useFakeTimers(); const f = await fixture(); let controller!: ReadableStreamDefaultController<Uint8Array>; const cancel = vi.fn();
    const raw = request(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
    const pending = f.app.fetch(raw); await vi.advanceTimersByTimeAsync(2000); controller.enqueue(encoded('{'));
    await vi.advanceTimersByTimeAsync(2000); controller.enqueue(encoded(' ')); await vi.advanceTimersByTimeAsync(1000);
    const response = await pending; expect(response.status).toBe(408); expect(cancel).toHaveBeenCalledOnce(); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an aborted body and releases its timer without a provider call', async () => {
    const f = await fixture(), abort = new AbortController(), cancel = vi.fn();
    const raw = request(new ReadableStream<Uint8Array>({ cancel }), { signal: abort.signal }), pending = f.app.fetch(raw);
    for (let i = 0; i < 20 && !raw.body!.locked; i++) await Promise.resolve(); abort.abort();
    expect((await pending).status).toBe(408); expect(cancel).toHaveBeenCalledOnce(); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(raw.body!.locked).toBe(false);
  });
  it('rejects missing bodies and pre-aborted requests', async () => {
    const absent = new Request('http://localhost' + docPath, { method: 'POST', headers });
    await expect(readFinancialPolicyWriteJson(absent, limit)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    const aborted = new AbortController(); aborted.abort();
    await expect(readFinancialPolicyWriteJson(request('{}', { signal: aborted.signal }), limit)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });
});
