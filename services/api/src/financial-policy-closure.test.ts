import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyCommandSchema, FinancialPolicyRecordSchema, FinancialPolicyResultSchema,
  FinancialPolicyOriginalClosureRequestSchema, financialPolicyOriginalClosureReceiptHash, financialPolicyOriginalClosureRoute,
  type FinancialPolicyOriginalClosureRequest } from '@pactwoven/contracts';
import { commandDigest, financialAuthorityFenceHash, financialPolicyCommandHash, financialPolicyRecordRef,
  financialPolicyTextHash, financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash, DomainError } from '@pactwoven/domain';
import type { FinancialPolicyReaderScope, FinancialPolicyReadObservation } from '@pactwoven/db';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyClosureGateway } from './financial-policy-closure-service.js';
import { validateFinancialPolicyClosureResponse } from './financial-worker-closure-result.js';
import { createApp } from './app.js';
import { serviceFinancialGateways, handlePrivateFinancialRequest, financialUrl, type FinancialGateways } from './worker-financial.js';

// In-memory synthetic identity and DB adapters only. No provider, credentials, funds or database access.
const token = 'synthetic.closure.token', issuer = 'https://synthetic.invalid', hash = 'a'.repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const unknown = { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503 };
async function fixture(rid: string | null = null) {
  let clock = Date.now(); const at = clock, time = (offset: number) => new Date(at + offset).toISOString();
  const scope: FinancialPolicyReaderScope = { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a',
    actor: { actorId: 'actor_a', membershipVersion: 2, subject: 'subject_a', externalMembershipId: 'member_a', sessionId: 'session_a' },
    organizationEpoch: 3, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const observation: FinancialPolicyReadObservation = { identity: { subject: 'subject_a', externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic',
    externalMembershipId: 'member_a', externalRole: 'org:member', sessionId: 'session_a', membershipObservedAt: time(-1000), authenticatedAt: time(-60_000) },
    observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: time(-30_000), observedAt: time(-500), expiresAt: time(300_000) } };
  const authority = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a',
    responsibility: { id: rid ?? 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none' as const, legacyHead: null };
  const { environment: _environment, organizationId: _organization, ...basis } = authority;
  const input = FinancialPolicyOriginalClosureRequestSchema.parse({ schemaVersion: 1, purpose: 'financial_policy_original_close', reason: 'original_input_unavailable',
    locator: { responsibilityId: rid, kind: 'save_document', key: 'original_request_12345', targetId: 'document_a', publicRequestHash: hash },
    expected: { environment: scope.environment, organizationId: scope.organizationId, actor: { actorId: scope.actor.actorId, membershipVersion: scope.actor.membershipVersion },
      organizationEpoch: scope.organizationEpoch, draftScope: rid === null ? null : { authority: basis, authorityHash: await financialAuthorityFenceHash(authority),
        site: { id: 'site_a', generation: 0, recordHash: hash } } } });
  async function closure(expected = input.expected) {
    const record = { schemaVersion: 1 as const, id: uuid(1), environment: expected.environment, organizationId: expected.organizationId,
      actor: structuredClone(expected.actor), locator: structuredClone(input.locator), reason: input.reason, expected: structuredClone(expected), closedAt: time(0),
      effectiveAuthority: false as const, financialState: null };
    return { ...record, recordHash: await financialPolicyOriginalClosureReceiptHash(record) };
  }
  async function original() {
    const command = FinancialPolicyCommandSchema.parse({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId,
      responsibilityId: rid, organizationEpoch: 1, id: input.locator.targetId, kind: 'save_document', key: input.locator.key, previous: null,
      purpose: rid === null ? 'budget_policy' : 'financial_mandate', text: 'Synthetic original reviewed document.' });
    const person = { ...scope.actor, membershipVersion: 1, sessionId: 'prior_session' };
    const body = FinancialPolicyRecordSchema.parse({ schemaVersion: 1, environment: command.environment, organizationId: command.organizationId,
      responsibilityId: rid, organizationEpoch: 1, id: command.id, version: 1, predecessor: null, actor: person,
      identityEvidence: { id: uuid(2), version: 1, recordHash: hash }, operationId: uuid(3), createdAt: time(-60_000),
      kind: 'document', purpose: command.kind === 'save_document' ? command.purpose : '', text: 'Synthetic original reviewed document.',
      contentHash: await financialPolicyTextHash('Synthetic original reviewed document.') });
    const result = FinancialPolicyResultSchema.parse({ schemaVersion: 1, id: uuid(3), environment: command.environment, organizationId: command.organizationId,
      actorId: person.actorId, responsibilityId: rid, kind: command.kind, key: command.key, commandHash: await financialPolicyCommandHash(person.actorId, command),
      target: await financialPolicyRecordRef(body), body, effectiveAuthority: false, financialState: null });
    const hscope = { environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actor.actorId };
    const request = await financialPolicyHttpRequestFromStoredCommand(hscope, command);
    input.locator.publicRequestHash = await financialPolicyHttpRequestHash(hscope, request);
    return { status: 'recorded' as const, original: { command, result }, closure: null };
  }
  let stored: unknown = { status: 'not_recorded', original: null, closure: null };
  const observe = vi.fn(async () => structuredClone(observation));
  const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe, now: () => clock, newId: () => uuid(9) });
  const identityEvidence = vi.fn(verifier.identityEvidence); verifier.identityEvidence = identityEvidence;
  const readers = { resolveObserver: vi.fn(async (): Promise<unknown> => structuredClone(scope)) };
  const authentication = { append: vi.fn(async (e: unknown): Promise<unknown> => ({ id: uuid(9), version: 1,
    recordHash: await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }) })) };
  const closures = {
    status: vi.fn(async (): Promise<unknown> => structuredClone(stored)),
    close: vi.fn(async (): Promise<unknown> => { stored = { status: 'closed', original: null, closure: await closure() }; return structuredClone(stored); }),
  };
  const dependencies = { environment: 'development' as const, issuer, verifier, readers, authentication, closures, now: () => clock };
  const gateway = createFinancialPolicyClosureGateway(dependencies);
  return { input, scope, observation, observe, identityEvidence, readers, authentication, closures, dependencies, gateway,
    closure, original, set: (v: unknown) => { stored = structuredClone(v); }, advance: (ms: number) => { clock += ms; }, time };
}
describe('original-key closure service', () => {
  it.each([null, 'responsibility_a'])('closes exact %s original once and confirms its independent receipt', async rid => {
    const f = await fixture(rid), v = await f.gateway.close(token, f.input);
    expect(v).toMatchObject({ status: 'closed', receipt: null, effectiveAuthority: false, financialState: null });
    expect(f.closures.status).toHaveBeenCalledTimes(2); expect(f.closures.close).toHaveBeenCalledOnce();
    expect(f.authentication.append).toHaveBeenCalledOnce(); expect(f.observe).toHaveBeenCalledExactlyOnceWith(token);
    expect(JSON.stringify(v)).not.toMatch(/subject|externalMembershipId|sessionId|tokenHash|identityEvidence/);
    const read = await f.gateway.status(token, f.input.locator); expect(read.closure).toEqual(v.closure);
  });
  it('allows scoped Operations responsibility closure but rejects a new Finance organization closure', async () => {
    const f = await fixture('responsibility_a'); f.scope.roles = ['operations']; expect((await f.gateway.close(token, f.input)).status).toBe('closed');
    const g = await fixture(); g.scope.roles = ['finance']; await expect(g.gateway.close(token, g.input)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
    expect(g.closures.close).not.toHaveBeenCalled();
  });
  it('closes a missing draft only in its exact responsibility scope', async () => {
    const f = await fixture('responsibility_a'); f.input.locator.kind = 'save_draft'; f.input.locator.targetId = 'draft_a';
    expect(await f.gateway.close(token, f.input)).toMatchObject({ status: 'closed', kind: 'save_draft', targetId: 'draft_a', receipt: null });
  });
  it('returns an existing genuine policy result before new owner checks', async () => {
    const f = await fixture(); f.scope.roles = ['finance']; f.set(await f.original());
    f.input.expected.actor.membershipVersion = 1; f.input.expected.organizationEpoch = 1;
    const v = await f.gateway.close(token, f.input); expect(v.status).toBe('recorded'); expect(v.closure).toBeNull();
    expect(v.receipt?.actor.membershipVersion).toBe(1); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it('returns a genuine save that wins between preflight and closure', async () => {
    const f = await fixture(), original = await f.original(); f.closures.close.mockImplementation(async () => { f.set(original); return original; });
    const v = await f.gateway.close(token, f.input); expect(v.status).toBe('recorded'); expect(v.closure).toBeNull(); expect(f.closures.close).toHaveBeenCalledOnce();
  });
  it('recovers immutable historical pins after current membership and epoch advance', async () => {
    const f = await fixture(), c = await f.closure(); f.set({ status: 'closed', original: null, closure: c });
    f.scope.actor.membershipVersion = 7; f.scope.organizationEpoch = 11;
    const v = await f.gateway.status(token, f.input.locator); expect(v.closure).toEqual(c); expect(v.scope.actor.membershipVersion).toBe(7);
    expect((await f.gateway.close(token, f.input)).closure).toEqual(c); // Existing closure wins over stale reviewed pins.
    f.input.expected.actor.membershipVersion = 7; f.input.expected.organizationEpoch = 11;
    expect((await f.gateway.close(token, f.input)).closure).toEqual(c); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it.each(['environment', 'organizationId', 'actor', 'organizationEpoch', 'draftScope'])('rejects missing %s pins before identity', async field => {
    const f = await fixture(), input = structuredClone(f.input); delete (input.expected as Record<string, unknown>)[field];
    await expect(f.gateway.close(token, input)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' }); expect(f.observe).not.toHaveBeenCalled();
  });
  it.each(['environment', 'organizationId', 'actorId', 'membershipVersion', 'organizationEpoch'])('rejects mismatched current %s pins before a new close', async field => {
    const f = await fixture();
    if (field === 'actorId') f.input.expected.actor.actorId = 'other_actor';
    else if (field === 'membershipVersion') f.input.expected.actor.membershipVersion++;
    else if (field === 'organizationEpoch') f.input.expected.organizationEpoch++;
    else (f.input.expected as Record<string, unknown>)[field] = field === 'environment' ? 'production' : 'other_org';
    await expect(f.gateway.close(token, f.input)).rejects.toMatchObject({ status: ['membershipVersion', 'organizationEpoch'].includes(field) ? 409 : 403 });
    expect(f.closures.status).toHaveBeenCalledTimes(['membershipVersion', 'organizationEpoch'].includes(field) ? 1 : 0); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it.each(['siteIds', 'actionSiteIds'] as const)('rejects absent current %s before close', async field => {
    const f = await fixture('responsibility_a'); f.scope[field] = [];
    await expect(f.gateway.close(token, f.input)).rejects.toMatchObject({ status: 403 }); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it('rejects a forged authority hash before insertion', async () => {
    const f = await fixture('responsibility_a'); f.input.expected.draftScope!.authorityHash = 'b'.repeat(64);
    await expect(f.gateway.close(token, f.input)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_SCOPE_CHANGED' }); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it.each(['wrong-token', 'stale', 'session', 'membership'])('requires genuine fresh identity despite valid pins: %s', async kind => {
    const f = await fixture();
    if (kind === 'stale') f.advance(30_000);
    if (kind === 'session') f.scope.actor.sessionId = 'another_session';
    if (kind === 'membership') f.observation.identity.externalMembershipId = 'another_membership';
    await expect(f.gateway.close(kind === 'wrong-token' ? 'different.token' : token, f.input)).rejects.toBeInstanceOf(DomainError);
    expect(f.closures.close).not.toHaveBeenCalled();
  });
  it.each(['forged-evidence', 'forged-reference', 'expired-after-append'])('rejects %s before status', async kind => {
    const f = await fixture();
    if (kind === 'forged-evidence') { const original = f.identityEvidence.getMockImplementation()!; f.identityEvidence.mockImplementation((...args) => ({ ...(original(...args) as object), organizationId: 'other_org' })); }
    if (kind === 'forged-reference') f.authentication.append.mockResolvedValue({ id: uuid(9), version: 1, recordHash: hash });
    if (kind === 'expired-after-append') { const original = f.authentication.append.getMockImplementation()!; f.authentication.append.mockImplementation(async e => { const result = await original(e); f.advance(30_000); return result; }); }
    await expect(f.gateway.close(token, f.input)).rejects.toBeInstanceOf(DomainError); expect(f.closures.status).not.toHaveBeenCalled();
  });
  it.each(['hash', 'tenant', 'actor', 'key', 'target', 'requestHash', 'reason', 'money', 'future'])('does not qualify forged closure %s', async kind => {
    const f = await fixture(), c = await f.closure();
    if (kind === 'hash') c.recordHash = 'b'.repeat(64);
    if (kind === 'tenant') c.organizationId = c.expected.organizationId = 'other_org';
    if (kind === 'actor') c.actor.actorId = c.expected.actor.actorId = 'other_actor';
    if (kind === 'key') c.locator.key = 'different_original_key';
    if (kind === 'target') c.locator.targetId = 'other_document';
    if (kind === 'requestHash') c.locator.publicRequestHash = 'b'.repeat(64);
    if (kind === 'reason') (c as Record<string, unknown>).reason = 'retry';
    if (kind === 'money') (c as Record<string, unknown>).financialState = 'CONFIRMED';
    if (kind === 'future') c.closedAt = f.time(60000);
    if (['tenant', 'actor', 'key', 'target', 'requestHash', 'future'].includes(kind)) c.recordHash = await financialPolicyOriginalClosureReceiptHash(c);
    f.set({ status: 'closed', original: null, closure: c }); await expect(f.gateway.status(token, f.input.locator)).rejects.toMatchObject(unknown);
  });
  it.each(['targetId', 'key', 'publicRequestHash'] as const)('reports a genuine original conflict for changed %s without closing', async field => {
    const f = await fixture(); f.set(await f.original()); f.input.locator[field] = field === 'publicRequestHash' ? 'b'.repeat(64) : 'other_original_target';
    await expect(f.gateway.close(token, f.input)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_KEY_CONFLICT' }); expect(f.closures.close).not.toHaveBeenCalled();
  });
  it.each(['lost-commit', 'forged-ack', 'missing-confirmation', 'stale-confirmation'])('never retries or declares absence after %s', async kind => {
    const f = await fixture(), original = f.closures.close.getMockImplementation()!;
    if (kind === 'lost-commit') f.closures.close.mockImplementation(async () => { await original(); throw new Error('PRIVATE_COMMIT_SENTINEL'); });
    if (kind === 'forged-ack') f.closures.close.mockImplementation(async () => ({ status: 'not_recorded', original: null, closure: null }));
    if (kind === 'missing-confirmation') f.closures.status.mockResolvedValue({ status: 'not_recorded', original: null, closure: null });
    if (kind === 'stale-confirmation') { const read = f.closures.status.getMockImplementation()!; f.closures.status.mockImplementation(async () => { if (f.closures.close.mock.calls.length) f.advance(30_000); return read(); }); }
    await expect(f.gateway.close(token, f.input)).rejects.toMatchObject(unknown); expect(f.closures.close).toHaveBeenCalledOnce();
  });
  it('captures the request and bound adapters before identity yields', async () => {
    const f = await fixture(); let release!: (v: FinancialPolicyReadObservation) => void;
    f.observe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const original = structuredClone(f.input), pending = f.gateway.close(token, f.input);
    f.input.locator.key = 'mutated_key_12345'; f.input.expected.organizationEpoch++;
    // Receipt production uses the captured original in this synthetic repository.
    f.closures.close.mockImplementation(async () => { const c = await f.closure(original.expected); c.locator = original.locator;
      c.recordHash = await financialPolicyOriginalClosureReceiptHash(c); const value = { status: 'closed', original: null, closure: c }; f.set(value); return value; });
    release(f.observation); expect((await pending).key).toBe(original.locator.key);
  });
});

describe('original-key closure HTTP and private Worker integration', () => {
  const request = (input: FinancialPolicyOriginalClosureRequest, path = financialPolicyOriginalClosureRoute(input.locator), body = JSON.stringify(input), extra: Record<string, string> = {}) =>
    new Request(`https://api.example${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.locator.key, ...extra }, body });
  it('does not claim original absence when the closure reader is unconfigured', async () => {
    const f = await fixture(), legacy = { context: vi.fn(), index: vi.fn(), get: vi.fn(), recover: vi.fn() };
    const app = createApp({ allowedOrigins: [], financialPolicyGateway: legacy });
    const q = f.input.locator, path = financialPolicyOriginalClosureRoute(q).replace(/\/close$/, '') + `?kind=${q.kind}&targetId=${q.targetId}&requestHash=${q.publicRequestHash}`;
    const result = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: { code: 'SETUP_REQUIRED' } }); expect(legacy.recover).not.toHaveBeenCalled();
  });
  it('keeps unsupported governance recovery on the legacy reader with a distinct null closure', async () => {
    const f = await fixture(), missing = await f.gateway.status(token, f.input.locator);
    const { closure: _closure, ...legacyMissing } = missing;
    const raw = { ...legacyMissing, kind: 'propose_governance', targetId: 'proposal_a' };
    const legacy = { context: vi.fn(), index: vi.fn(), get: vi.fn(), recover: vi.fn(async () => raw) };
    const app = createApp({ allowedOrigins: [], financialPolicyGateway: legacy as unknown as FinancialGateways['financialPolicy'] });
    const result = await app.request(`/v1/financial-governance/operations/${raw.key}?kind=propose_governance&targetId=proposal_a&requestHash=${raw.publicRequestHash}`,
      { headers: { Authorization: `Bearer ${token}` } });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ status: 'not_recorded', receipt: null, closure: null }); expect(legacy.recover).toHaveBeenCalledOnce();
  });
  it('passes through the public route, isolated Worker and genuine service then GET recovers closed', async () => {
    const f = await fixture(), gateways = { financialPolicyClosure: f.gateway } as FinancialGateways;
    const fetch = vi.fn((r: Request) => handlePrivateFinancialRequest(r, issuer, () => gateways));
    const r = request(f.input), proxy = serviceFinancialGateways({ fetch }, r, issuer);
    const app = createApp({ allowedOrigins: [], financialPolicyClosureGateway: proxy.financialPolicyClosure });
    const response = await app.fetch(r); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'closed', receipt: null });
    expect(fetch).toHaveBeenCalledOnce(); expect(f.closures.close).toHaveBeenCalledOnce();
    const q = f.input.locator, path = financialPolicyOriginalClosureRoute(q).replace(/\/close$/, '') + `?kind=${q.kind}&targetId=${q.targetId}&requestHash=${q.publicRequestHash}`;
    const get = new Request(`https://api.example${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const adapter = serviceFinancialGateways({ fetch }, get, issuer);
    const readApp = createApp({ allowedOrigins: [], financialPolicyClosureGateway: adapter.financialPolicyClosure });
    const read = await readApp.fetch(get); expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ status: 'closed', receipt: null });
  });
  it.each(['wrong-key', 'wrong-route-key', 'wrong-scope', 'trailing-slash', 'query', 'empty-query', 'encoded', 'missing-key', 'missing-auth', 'unsupported-kind', 'duplicate-key', 'oversized', 'compressed'])
    ('rejects %s without closure service work', async kind => {
      const f = await fixture(), gateway = { close: vi.fn(), status: vi.fn() }, app = createApp({ allowedOrigins: [], financialPolicyClosureGateway: gateway });
      let path = financialPolicyOriginalClosureRoute(f.input.locator), body = JSON.stringify(f.input); const extra: Record<string, string> = {};
      if (kind === 'wrong-key') extra['Idempotency-Key'] = 'wrong_original_key';
      if (kind === 'wrong-route-key') path = path.replace(f.input.locator.key, 'wrong_original_key');
      if (kind === 'wrong-scope') path = `/v1/responsibilities/other/financial-policy-operations/${f.input.locator.key}/close`;
      if (kind === 'trailing-slash') path += '/'; if (kind === 'query') path += '?x=y'; if (kind === 'empty-query') path += '?';
      if (kind === 'encoded') path = path.replace('close', '%63lose');
      if (kind === 'missing-key') extra['Idempotency-Key'] = ''; if (kind === 'missing-auth') extra.Authorization = '';
      if (kind === 'unsupported-kind') body = body.replace('save_document', 'withdraw_draft');
      if (kind === 'duplicate-key') body = body.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
      if (kind === 'oversized') body = ' '.repeat(8193) + body; if (kind === 'compressed') extra['Content-Encoding'] = 'gzip';
      const response = await app.fetch(request(f.input, path, body, extra));
      expect(response.status).toBeGreaterThanOrEqual(400); expect(gateway.close).not.toHaveBeenCalled(); expect(gateway.status).not.toHaveBeenCalled();
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
  it.each(['hash', 'locator', 'not_recorded', 'identity'])('rejects private forged %s results and never retries', async kind => {
    const f = await fixture(), v = await f.gateway.close(token, f.input), bad = structuredClone(v);
    if (bad.status !== 'closed') throw new Error('Fixture needs closure');
    if (kind === 'hash') bad.closure.recordHash = 'b'.repeat(64);
    if (kind === 'locator') bad.targetId = 'another_document';
    if (kind === 'identity') bad.scope.actor.actorId = 'another_actor';
    const data = kind === 'not_recorded' ? { ...bad, status: 'not_recorded', closure: null } : bad;
    const privateGateway = { financialPolicyClosure: { close: vi.fn(async () => data), status: vi.fn() } } as unknown as FinancialGateways;
    const fetch = vi.fn((r: Request) => handlePrivateFinancialRequest(r, issuer, () => privateGateway));
    const proxy = serviceFinancialGateways({ fetch }, request(f.input), issuer);
    await expect(proxy.financialPolicyClosure!.close(token, f.input)).rejects.toMatchObject(unknown); expect(fetch).toHaveBeenCalledOnce();
  });
  it('requires exact key before forwarding and rejects oversized private intent before gateway construction', async () => {
    const f = await fixture(), fetch = vi.fn();
    await expect(serviceFinancialGateways({ fetch }, request(f.input, undefined, undefined, { 'Idempotency-Key': 'wrong_original_key' }), issuer)
      .financialPolicyClosure!.close(token, f.input)).rejects.toMatchObject(unknown); expect(fetch).not.toHaveBeenCalled();
    const factory = vi.fn();
    const wire = { nonce: uuid(8), request: { url: request(f.input).url, method: 'POST', correlationId: 'trace' }, action: { kind: 'policy-close-original', input: { ...f.input, extra: 'x'.repeat(8193) } } };
    const result = await handlePrivateFinancialRequest(new Request(financialUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(wire) }), issuer, factory);
    expect(result.status).toBe(422); expect(factory).not.toHaveBeenCalled();
  });
  it('rejects a changed POST response stable identity while retaining historical receipt pins', async () => {
    const f = await fixture(), v = await f.gateway.close(token, f.input), bad = structuredClone(v); bad.scope.organizationId = 'other_org';
    await expect(validateFinancialPolicyClosureResponse(f.input, bad)).rejects.toMatchObject(unknown);
  });
});
