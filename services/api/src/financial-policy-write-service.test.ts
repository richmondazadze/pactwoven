import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, FinancialPolicyCommandSchema, FinancialPolicyRecordSchema, FinancialPolicyResultSchema,
  financialPolicyHttpRoute, type FinancialPolicyActor, type FinancialPolicyCommand, type FinancialPolicyResult, type Role } from '@pactwoven/contracts';
import { DomainError, commandDigest, financialPolicyRecordRef, financialPolicyTextHash, financialPolicyCommandHash,
  financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash, physicalAssetKey, financialBudgetAccountId, financialBudgetPeriodId } from '@pactwoven/domain';
import type { FinancialPolicyReaderScope, FinancialPolicyReadObservation } from '@pactwoven/db';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyWriteGateway, safeFinancialPolicyWriteApiError, snapshotFinancialPolicyWriteRequest,
  validateFinancialPolicyWriteResponse, type FinancialPolicyWriteRequest } from './financial-policy-write-service.js';

// All adapters and identities in this file are synthetic. No database/provider/factor/wallet is invoked.
const at = Date.parse('2026-11-15T12:00:00.000Z'), time = (offset: number) => new Date(at + offset).toISOString();
const token = 'synthetic.write.token', issuer = 'https://synthetic.invalid', hash = 'a'.repeat(64);
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const actor: FinancialPolicyActor = { actorId: 'actor_a', membershipVersion: 1, subject: 'subject_a', externalMembershipId: 'member_a', sessionId: 'old_session' };
type Pair = { command: FinancialPolicyCommand; result: FinancialPolicyResult };
function replace<T>(input: T, path: string[], value: unknown): T {
  const result = structuredClone(input); let parent = result as Record<string, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = value; return result;
}
async function fixture(role: Role = 'owner') {
  let clock = at, sequence = 100, persisted: Pair | null = null;
  const scope: FinancialPolicyReaderScope = { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a',
    actor: { ...actor, membershipVersion: 9, sessionId: 'current_session' }, organizationEpoch: 2, roles: [role], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const observation: FinancialPolicyReadObservation = { identity: { subject: 'subject_a', externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic',
    externalMembershipId: 'member_a', externalRole: 'org:member', sessionId: 'current_session', membershipObservedAt: time(-1000), authenticatedAt: time(-60_000) },
    observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: time(-30_000), observedAt: time(-500), expiresAt: time(300_000) } };
  const common = (kind: string, id: string, responsibilityId: string | null = null) => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    organizationEpoch: 2, kind, id, responsibilityId, key: `original_${kind}_${id}`, previous: null });
  let saved: Pair;
  async function pair(input: unknown, person = actor): Promise<Pair> {
    const command = FinancialPolicyCommandSchema.parse(input), operationId = uuid(sequence++);
    const base = { schemaVersion: 1, environment: command.environment, organizationId: command.organizationId, responsibilityId: command.responsibilityId,
      id: command.id, version: (command.previous?.version ?? 0) + 1, predecessor: command.previous, actor: person,
      identityEvidence: { id: uuid(sequence++), version: 1, recordHash: hash }, organizationEpoch: command.organizationEpoch, operationId, createdAt: time(-300_000) };
    let fields: object;
    if (command.kind === 'save_document') fields = { kind: 'document', purpose: command.purpose, text: command.text, contentHash: await financialPolicyTextHash(command.text) };
    else if (command.kind === 'save_draft') fields = { kind: 'draft', state: 'DRAFT', requester: person, draft: command.draft };
    else if (command.kind === 'withdraw_draft' && saved.result.body.kind === 'draft') fields = { kind: 'draft', state: 'WITHDRAWN', requester: saved.result.body.requester, draft: saved.result.body.draft };
    else if (command.kind === 'propose_governance') fields = { kind: 'governance', state: 'OPEN', proposer: person, bundle: command.bundle,
      expectedControl: command.expectedControl, expiresAt: command.expiresAt, decisionNonce: 'A'.repeat(43), decision: null };
    else throw new Error('Only four synthetic commands supported.');
    const body = FinancialPolicyRecordSchema.parse({ ...base, ...fields });
    const result = FinancialPolicyResultSchema.parse({ schemaVersion: 1, id: operationId, environment: command.environment, organizationId: command.organizationId,
      actorId: person.actorId, responsibilityId: command.responsibilityId, kind: command.kind, key: command.key,
      commandHash: await financialPolicyCommandHash(person.actorId, command), target: await financialPolicyRecordRef(body), body, effectiveAuthority: false, financialState: null });
    return { command, result };
  }
  const mandate = await pair({ ...common('save_document', 'mandate_doc', 'responsibility_a'), purpose: 'financial_mandate', text: 'Exact mandate.\nCafé 🧵' });
  const budget = await pair({ ...common('save_document', 'budget_doc'), purpose: 'budget_policy', text: 'Exact budget policy.' });
  const approval = await pair({ ...common('save_document', 'approval_doc'), purpose: 'approval_policy', text: 'Exact approval policy.' });
  const authority = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draft = { scope: { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }), site: { id: 'site_a', generation: 0, recordHash: hash } },
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...mandate.result.target, purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null, startsAt: time(-200_000), expiresAt: time(300_000) };
  saved = await pair({ ...common('save_draft', 'draft_a', 'responsibility_a'), draft });
  const withdrawn = await pair({ ...common('withdraw_draft', 'draft_a', 'responsibility_a'), previous: saved.result.target });
  const asset = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: hash, financialUseEpoch: 0 };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key), control = { budgetAccountId, generation: 0, accepted: null };
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, time(-300_000), time(600_000)), startsAt: time(-300_000), endsAt: time(600_000) },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal',
      thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...approval.result.target, purpose: 'approval_policy' }, { ...budget.result.target, purpose: 'budget_policy' }] };
  const proposal = await pair({ ...common('propose_governance', 'proposal_a'), bundle, expectedControl: control, expiresAt: time(300_000) });
  const observe = vi.fn(async () => structuredClone(observation));
  const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe, now: () => clock, newId: () => uuid(999) });
  const identityEvidence = vi.fn(verifier.identityEvidence); verifier.identityEvidence = identityEvidence;
  const readers = { resolveObserver: vi.fn(async (_environment: unknown, _observation: FinancialPolicyReadObservation): Promise<unknown> => structuredClone(scope)),
    original: vi.fn(async (): Promise<unknown> => structuredClone(persisted)) };
  const authentication = { append: vi.fn(async (e: unknown): Promise<unknown> => ({ id: uuid(999), version: 1,
    recordHash: await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }) })) };
  const repository = { mutate: vi.fn(async (_eid: string, input: FinancialPolicyCommand): Promise<unknown> => { persisted = await pair(input, scope.actor); return structuredClone(persisted.result); }) };
  const dependencies = { environment: 'development' as const, issuer, verifier, readers, authentication, repository, now: () => clock };
  const gateway = createFinancialPolicyWriteGateway(dependencies);
  const request = async (value = mandate) => snapshotFinancialPolicyWriteRequest(await financialPolicyHttpRequestFromStoredCommand({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a' }, value.command));
  return { gateway, dependencies, scope, observation, observe, identityEvidence, readers, authentication, repository, request, pair,
    mandate, budget, approval, saved, withdrawn, proposal, control, advance: (ms: number) => { clock += ms; },
    persist: (value: Pair | null) => { persisted = structuredClone(value); }, persisted: () => persisted };
}
const unknown = { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503 }, denied = { code: 'FINANCIAL_POLICY_ACCESS_DENIED', status: 403 };

describe('financial-policy first-four write gateway (synthetic adapters)', () => {
  it.each(['mandate', 'budget', 'saved', 'withdrawn', 'proposal'] as const)('records %s exactly once and confirms the stored pair', async name => {
    const f = await fixture(), request = await f.request(f[name]), result = await f.gateway.submit(token, request);
    expect(result).toMatchObject({ status: 'recorded', effectiveAuthority: false, financialState: null, scope: { actor: { membershipVersion: 9 } },
      observation: { observedAt: time(-1000), expiresAt: time(19_000) }, receipt: { kind: request.kind, key: request.key, target: { id: request.id } } });
    expect(f.repository.mutate).toHaveBeenCalledExactlyOnceWith(uuid(999), f[name].command);
    expect(f.readers.original).toHaveBeenCalledTimes(2); expect(f.authentication.append).toHaveBeenCalledOnce();
    expect(f.authentication.append.mock.calls[0]?.[0]).toMatchObject({ kind: 'identity', purpose: 'financial_policy_observation' });
    expect(result.receipt.publicRequestHash).not.toBe(f.persisted()?.result.commandHash);
    expect(JSON.stringify(result)).not.toMatch(/subject|externalMembershipId|sessionId|tokenHash|identityEvidence|decisionNonce|commandHash/);
    expect(Object.keys(f.gateway)).toEqual(['submit']); expect(Object.keys(f.dependencies.repository)).toEqual(['mutate']);
  });
  it('recovers an original before current owner/epoch checks and preserves historical membership', async () => {
    const f = await fixture('finance'); f.persist(f.budget); f.scope.organizationEpoch = 3;
    const result = await f.gateway.submit(token, await f.request(f.budget));
    expect(result.receipt.actor.membershipVersion).toBe(1); expect(result.scope.actor.membershipVersion).toBe(9);
    expect(result.receipt.record.organizationEpoch).toBe(2); expect(f.repository.mutate).not.toHaveBeenCalled(); expect(f.readers.original).toHaveBeenCalledOnce();
  });
  it.each(['mandate', 'saved', 'proposal'] as const)('preserves the exact reviewed predecessor for a new %s revision', async name => {
    const f = await fixture(), old = f[name];
    const revision = await f.pair({ ...old.command, previous: old.result.target, key: `revision_${old.command.key}` });
    const input = await f.request(revision), result = await f.gateway.submit(token, input);
    expect(result.receipt.record.predecessor).toEqual(old.result.target); expect(result.receipt.record.version).toBe(2);
    expect(f.repository.mutate).toHaveBeenCalledExactlyOnceWith(uuid(999), revision.command);
    expect(f.readers.original).toHaveBeenCalledTimes(2);
  });
  it('recovers an expired historical draft before new interval checks', async () => {
    const f = await fixture(), expiredPair = await f.pair(replace(f.saved.command, ['draft', 'expiresAt'], time(-1000)));
    f.persist(expiredPair); expect((await f.gateway.submit(token, await f.request(expiredPair))).receipt.record).toMatchObject({ kind: 'draft', draft: { expiresAt: time(-1000) } });
    expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['budget', 'proposal'] as const)('requires owner for a new organization %s after permitted original preflight', async name => {
    const f = await fixture('finance'); await expect(f.gateway.submit(token, await f.request(f[name]))).rejects.toMatchObject(denied);
    expect(f.readers.original).toHaveBeenCalledOnce(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('blocks Operations organization access before append/original/mutation', async () => {
    const f = await fixture('operations'); await expect(f.gateway.submit(token, await f.request(f.budget))).rejects.toMatchObject(denied);
    expect(f.authentication.append).not.toHaveBeenCalled(); expect(f.readers.original).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['mandate', 'saved', 'withdrawn'] as const)('permits scoped Operations %s through the paired SQL recheck seam', async name => {
    const f = await fixture('operations'); expect((await f.gateway.submit(token, await f.request(f[name]))).status).toBe('recorded');
    expect(f.repository.mutate).toHaveBeenCalledOnce();
  });
  it.each(['siteIds', 'actionSiteIds'] as const)('checks explicit %s for new draft/proposal material', async field => {
    for (const name of ['saved', 'proposal'] as const) {
      const f = await fixture(); f.scope[field] = [];
      await expect(f.gateway.submit(token, await f.request(f[name]))).rejects.toMatchObject(denied); expect(f.repository.mutate).not.toHaveBeenCalled();
    }
  });
  it('does not replace a reviewed epoch or expired interval for a new write', async () => {
    const f = await fixture(); f.scope.organizationEpoch = 3;
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_SCOPE_CHANGED' });
    expect(f.repository.mutate).not.toHaveBeenCalled();
    const g = await fixture(), expiredPair = await g.pair(replace(g.saved.command, ['draft', 'expiresAt'], time(-1000)));
    await expect(g.gateway.submit(token, await g.request(expiredPair))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_EXPIRED' });
    expect(g.repository.mutate).not.toHaveBeenCalled();
  });
  it('conflicts on changed visible input under an existing original key without mutating', async () => {
    const f = await fixture(); f.persist(f.mandate);
    const request = replace(await f.request(), ['input', 'text'], 'Changed visible terms');
    await expect(f.gateway.submit(token, request)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_KEY_CONFLICT', status: 409 });
    expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each([
    [['result', 'commandHash'], 'f'.repeat(64)], [['result', 'body', 'actor', 'subject'], 'other_subject'],
    [['result', 'body', 'actor', 'externalMembershipId'], 'other_member'], [['result', 'body', 'actor', 'actorId'], 'other_actor'],
    [['result', 'target', 'recordHash'], 'f'.repeat(64)], [['result', 'key'], 'other_original_key'], [['result', 'body', 'id'], 'other_target'],
    [['command', 'text'], 'Corrupt command text'],
  ] as [string[], unknown][])('rejects corrupt original at %j without converting it to absence', async (path, value) => {
    const f = await fixture(); f.readers.original.mockResolvedValue(replace(f.mandate, path, value));
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(unknown); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { status: 'not_recorded' }])('rejects unknown original response %j rather than submitting', async raw => {
    const f = await fixture(); f.readers.original.mockResolvedValue(raw);
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(unknown); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('keeps responsibility original denial or outage ahead of any mutation', async () => {
    const f = await fixture(); f.readers.original.mockRejectedValue(new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'synthetic SQL site denial'));
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(denied); expect(f.repository.mutate).not.toHaveBeenCalled();
    f.readers.original.mockRejectedValue(new Error('private SQL unavailable'));
    await expect(f.gateway.submit(token, await f.request())).rejects.toThrow(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['observe', 'resolve', 'append', 'original'] as const)('expires a %s wait before mutation and never refreshes timestamps', async point => {
    const f = await fixture();
    if (point === 'observe') f.observe.mockImplementation(async () => { f.advance(20_000); return f.observation; });
    if (point === 'resolve') f.readers.resolveObserver.mockImplementation(async () => { f.advance(20_000); return f.scope; });
    if (point === 'append') f.authentication.append.mockImplementation(async () => { f.advance(20_000); return {}; });
    if (point === 'original') f.readers.original.mockImplementation(async () => { f.advance(20_000); return null; });
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_EXPIRED' }); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['environment', 'actor', 'issuer', 'hash', 'evidence', 'evidence_ref'] as const)('independently rejects forged %s before original lookup', async mode => {
    const f = await fixture();
    if (mode === 'environment') f.readers.resolveObserver.mockResolvedValue({ ...f.scope, environment: 'production' });
    if (mode === 'actor') f.readers.resolveObserver.mockResolvedValue(replace(f.scope, ['actor', 'sessionId'], 'other_session'));
    if (mode === 'issuer') f.observe.mockResolvedValue(replace(f.observation, ['observation', 'issuer'], 'https://other.invalid'));
    if (mode === 'hash') f.observe.mockResolvedValue(replace(f.observation, ['observation', 'tokenHash'], 'f'.repeat(64)));
    if (mode === 'evidence') f.identityEvidence.mockReturnValue({ ...f.observation, verified: true });
    if (mode === 'evidence_ref') f.authentication.append.mockResolvedValue({ id: uuid(999), version: 1, recordHash: 'f'.repeat(64) });
    await expect(f.gateway.submit(token, await f.request())).rejects.toThrow(); expect(f.readers.original).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('captures input, functions and scope before callbacks can alter their sources', async () => {
    const f = await fixture(), input = structuredClone(await f.request()), originalMutate = f.repository.mutate;
    f.observe.mockImplementation(async () => { if (input.kind === 'save_document') input.input.text = 'changed during observe'; return structuredClone(f.observation); });
    f.readers.resolveObserver.mockImplementation(async (_environment, inputObservation) => { inputObservation.identity.subject = 'tampered callback'; return structuredClone(f.scope); });
    f.dependencies.repository.mutate = vi.fn(async () => { throw new Error('replacement'); }); f.dependencies.issuer = 'https://other.invalid';
    const result = await f.gateway.submit(token, input); expect(result.receipt.record).toMatchObject({ kind: 'document', text: 'Exact mandate.\nCafé 🧵' });
    expect(originalMutate).toHaveBeenCalledOnce(); expect(f.dependencies.repository.mutate).not.toHaveBeenCalled();
  });
  it('rejects an append callback that hashes altered evidence without changing the original local identity', async () => {
    const f = await fixture();
    f.authentication.append.mockImplementation(async input => {
      const changed = input as { actor: { subject: string } }; changed.actor.subject = 'other_subject';
      return { id: uuid(999), version: 1, recordHash: await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: input }) };
    });
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(unknown);
    expect(f.scope.actor.subject).toBe('subject_a'); expect(f.observation.identity.subject).toBe('subject_a');
    expect(f.readers.original).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it.each(['throw', 'typed_rejection', 'null_ack', 'wrong_actor', 'bad_hash', 'expiry', 'missing_confirmation', 'bad_confirmation', 'denied_confirmation', 'expired_confirmation'] as const)
    ('retains unknown after dispatch failure %s with at most one mutation', async mode => {
      const f = await fixture(), realMutate = f.repository.mutate.getMockImplementation()!;
      f.repository.mutate.mockImplementation(async (e, command) => {
        if (mode === 'throw') throw new Error('lost SQL acknowledgement');
        if (mode === 'typed_rejection') throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'private SQL conflict');
        const ack = await realMutate(e, command);
        if (mode === 'null_ack') return null;
        if (mode === 'wrong_actor') return replace(ack, ['body', 'actor', 'subject'], 'other_subject');
        if (mode === 'bad_hash') return replace(ack, ['commandHash'], 'f'.repeat(64));
        if (mode === 'expiry') f.advance(20_000);
        return ack;
      });
      if (mode.endsWith('confirmation')) f.readers.original.mockImplementation(async () => {
        if (f.repository.mutate.mock.calls.length === 0) return null;
        if (mode === 'missing_confirmation') return null;
        if (mode === 'bad_confirmation') return replace(f.persisted(), ['result', 'target', 'recordHash'], 'f'.repeat(64));
        if (mode === 'denied_confirmation') throw new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'revoked');
        f.advance(20_000); return f.persisted();
      });
      await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(unknown);
      expect(f.repository.mutate).toHaveBeenCalledOnce(); expect(f.readers.original.mock.calls.length).toBeLessThanOrEqual(2);
    });
  it('handles an exact racing original acknowledgement without requiring current membership in its historical receipt', async () => {
    const f = await fixture(); f.repository.mutate.mockImplementation(async () => { f.persist(f.mandate); return f.mandate.result; });
    const result = await f.gateway.submit(token, await f.request());
    expect(result.scope.actor.membershipVersion).toBe(9); expect(result.receipt.actor.membershipVersion).toBe(1); expect(f.repository.mutate).toHaveBeenCalledOnce();
  });
  it('requires post-ack stored pair to equal the acknowledgement even if both are individually valid', async () => {
    const f = await fixture(), second = await f.pair(f.mandate.command, f.scope.actor);
    f.readers.original.mockImplementation(async () => f.repository.mutate.mock.calls.length ? second : null);
    await expect(f.gateway.submit(token, await f.request())).rejects.toMatchObject(unknown); expect(f.repository.mutate).toHaveBeenCalledOnce();
  });
  it.each(['accept_governance', 'reject_governance'] as const)('rejects otherwise valid %s before authenticator work', async kind => {
    const f = await fixture(), identity = { kind, responsibilityId: null, id: 'proposal_a' };
    const unsupported = { ...identity, route: financialPolicyHttpRoute(identity), key: 'original_unsupported_key', input: { schemaVersion: 1, previous: f.proposal.result.target, organizationEpoch: 2, expectedControl: f.control } };
    await expect(f.gateway.submit(token, unsupported as unknown as FinancialPolicyWriteRequest)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    expect(f.observe).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('rejects browser authority and altered trust/basis material without replacing it', async () => {
    const f = await fixture(), request = await f.request(f.saved);
    await expect(f.gateway.submit(token, { ...request, actorId: 'actor_a' } as unknown as FinancialPolicyWriteRequest)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    expect(f.observe).not.toHaveBeenCalled();
    await expect(f.gateway.submit(token, replace(request, ['input', 'draft', 'scope', 'authorityHash'], 'f'.repeat(64)))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INVALID' });
    expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('public response validation rejects substituted material or digest', async () => {
    const f = await fixture(), request = await f.request(), result = await f.gateway.submit(token, request);
    for (const modified of [replace(result, ['receipt', 'record', 'text'], 'Substituted'), replace(result, ['receipt', 'publicRequestHash'], 'f'.repeat(64)),
      { ...result, privateEvidence: hash }]) await expect(validateFinancialPolicyWriteResponse(request, modified)).rejects.toMatchObject(unknown);
    expect(result.receipt.publicRequestHash).toBe(await financialPolicyHttpRequestHash({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a' }, request));
  });
  it('uses only fixed safe error mapping with an explicit unknown-result message', () => {
    for (const [code, status] of [['AUTH_REQUIRED', 401], ['SETUP_REQUIRED', 503], ['NOT_FOUND', 404], ['BODY_TOO_LARGE', 413], ['REQUEST_TIMEOUT', 408],
      ['UNSUPPORTED_MEDIA_TYPE', 415], ['FINANCIAL_POLICY_INPUT_INVALID', 422], ['FINANCIAL_POLICY_INVALID', 422], ['FINANCIAL_POLICY_ACCESS_DENIED', 403],
      ['FINANCIAL_POLICY_SCOPE_CHANGED', 409], ['FINANCIAL_POLICY_EXPIRED', 409], ['FINANCIAL_POLICY_UNAVAILABLE', 409], ['FINANCIAL_POLICY_KEY_CONFLICT', 409]] as const) {
      const result = safeFinancialPolicyWriteApiError(new DomainError(code, status, 'private policy diagnostic'));
      expect(result.code).toBe(code); expect(result.status).toBe(status); expect(result.message).not.toContain('private');
    }
    expect(safeFinancialPolicyWriteApiError(new Error('private provider token'))).toEqual({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503,
      message: 'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.' });
  });
});
