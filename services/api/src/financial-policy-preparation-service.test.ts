import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, decodeSolanaBase58, FinancialPolicyRecordSchema, FinancialPolicyPreparationResponseSchema,
  type FinancialPolicyPreparationRequest, type FinancialPolicyRead, type FinancialPolicyRecord, type Role } from '@pactwoven/contracts';
import { FinancialPolicyPreparationSchema, financialPolicyPreparationReasons,
  type FinancialPolicyPreparation, type FinancialPolicyReaderScope } from '@pactwoven/db';
import { DomainError, commandDigest, financialPolicyRecordRef, financialPolicyTextHash, physicalAssetKey,
  financialBudgetAccountId, financialBudgetPeriodId } from '@pactwoven/domain';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyPreparationGateway, safeFinancialPolicyPreparationApiError,
  validateFinancialPolicyPreparationResponse } from './financial-policy-preparation-service.js';

vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('Database construction forbidden in source-only preparation tests.'); } } }));
const at = Date.parse('2026-11-15T12:00:00.000Z'), time = (delta: number) => new Date(at + delta).toISOString();
const token = 'synthetic.preparation.token', issuer = 'https://synthetic.invalid', rid = 'responsibility_a', hash = 'a'.repeat(64);
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function replace<T>(value: T, path: string[], next: unknown): T {
  const result = structuredClone(value); let parent = result as Record<string, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = next; return result;
}
async function fixture(role: Role = 'owner') {
  let clock = at;
  const original = { actorId: 'actor_a', membershipVersion: 1, subject: 'subject_a', externalMembershipId: 'membership_a', sessionId: 'old_session' };
  const scope: FinancialPolicyReaderScope = { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a',
    actor: { ...original, membershipVersion: 9, sessionId: 'current_session' }, organizationEpoch: 4, roles: [role], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const observation = { identity: { subject: original.subject, externalOrganizationId: scope.externalOrganizationId, externalOrganizationName: 'Synthetic',
    externalMembershipId: original.externalMembershipId, externalRole: 'org:member', sessionId: scope.actor.sessionId,
    membershipObservedAt: time(-1000), authenticatedAt: time(-60_000) },
    observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: time(-30_000), observedAt: time(-500), expiresAt: time(300_000) } };
  const authority = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a',
    responsibility: { id: rid, version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none' as const, legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }),
    site: { id: 'site_a', generation: 0, recordHash: hash } };
  let sequence = 0;
  async function read(fields: object, id: string, responsibilityId: string | null): Promise<FinancialPolicyRead> {
    const record = FinancialPolicyRecordSchema.parse({ schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId,
      id, version: 1, predecessor: null, actor: original, identityEvidence: { id: uuid(++sequence), version: 1, recordHash: hash },
      organizationEpoch: 2, operationId: uuid(++sequence), createdAt: time(-100_000), ...fields });
    return { record, reference: await financialPolicyRecordRef(record), current: true, state: record.kind === 'document' ? 'DOCUMENT' : 'EXPIRED',
      blockers: record.kind === 'draft' ? ['DRAFT_EXPIRED', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] : [], effectiveAuthority: false };
  }
  async function doc(id: string, purpose: string, responsibilityId: string | null) {
    const text = `Exact ${purpose} terms.\nCafé 🧵`;
    return read({ kind: 'document', purpose, text, contentHash: await financialPolicyTextHash(text) }, id, responsibilityId);
  }
  const mandate = await doc('mandate_doc', 'financial_mandate', rid), budget = await doc('budget_doc', 'budget_policy', null), approval = await doc('approval_doc', 'approval_policy', null);
  const draft = await read({ kind: 'draft', state: 'DRAFT', requester: original,
    draft: { scope: draftScope, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
      documents: [{ ...mandate.reference, purpose: 'financial_mandate' }], asset: null, account: null, governance: null, trust: null,
      startsAt: time(-100_000), expiresAt: time(-50_000) } }, 'draft_a', rid);
  const pin = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: hash, financialUseEpoch: 0 };
  const hex = (v: string) => Buffer.from(decodeSolanaBase58(v, 32)).toString('hex');
  const asset = { pin, genesisHex: hex(FINANCE_DEVNET_ASSET.genesis), tokenProgramHex: hex(FINANCE_DEVNET_ASSET.tokenProgram), mintHex: hex(FINANCE_DEVNET_ASSET.mint),
    decimals: 6, policy: 'solana-original-devnet-usdc-v1' };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', pin.key), control = { budgetAccountId, generation: 0, accepted: null };
  const period = { id: await financialBudgetPeriodId(budgetAccountId, time(-200_000), time(900_000)), startsAt: time(-200_000), endsAt: time(900_000) };
  const proposal = await read({ kind: 'governance', state: 'OPEN', proposer: original, expectedControl: control, decisionNonce: 'A'.repeat(43),
    expiresAt: time(-50_000), decision: null,
    bundle: { budgetAccountId, asset: pin, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' }, period,
      approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'], action: 'allocate_funds',
        category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
      documents: [{ ...approval.reference, purpose: 'approval_policy' }, { ...budget.reference, purpose: 'budget_policy' }] } }, 'proposal_a', null);
  const selections: Record<FinancialPolicyPreparationRequest['action'], FinancialPolicyPreparationRequest> = {
    save_document: { schemaVersion: 1, action: 'save_document', targetId: 'new_document', previous: null, purpose: 'budget_policy' },
    save_draft: { schemaVersion: 1, action: 'save_draft', targetId: draft.reference.id, previous: draft.reference, document: mandate.reference },
    withdraw_draft: { schemaVersion: 1, action: 'withdraw_draft', targetId: draft.reference.id, previous: draft.reference },
    propose_governance: { schemaVersion: 1, action: 'propose_governance', targetId: proposal.reference.id, previous: proposal.reference,
      assetKey: pin.key, budgetDocument: budget.reference, approvalDocument: approval.reference },
  };
  function facts(action: FinancialPolicyPreparationRequest['action'] = 'save_document'): FinancialPolicyPreparation {
    const selection = structuredClone(selections[action]), target = action === 'save_document' ? null : action === 'propose_governance' ? proposal : draft;
    const material = action === 'save_document' ? { action, purpose: 'budget_policy', organizationEpoch: scope.organizationEpoch, draftScope: null, siteActive: null } :
      action === 'save_draft' ? { action, profile: 'incomplete', draftScope, siteActive: true, document: mandate, asset: null, account: null, governance: null, trust: null } :
      action === 'withdraw_draft' ? { action } : { action, asset, budgetAccountId, control, acceptedConfiguration: null, periods: [period], budgetDocument: budget,
        approvalDocument: approval, eligibleActionSites: [{ id: 'site_a', generation: 0, recordHash: hash }] };
    return decision({ schemaVersion: 1, scope: structuredClone(scope), responsibilityId: action === 'save_draft' || action === 'withdraw_draft' ? rid : null,
      selection, target: target ? { state: 'exact', latestReference: target.reference, record: target,
        historicalDocuments: action === 'propose_governance' ? [approval, budget] : [mandate], control: action === 'propose_governance' ? control : null } :
        { state: 'absent', latestReference: null, record: null, historicalDocuments: [], control: null },
      material, originalActorMatches: target ? true : null, decision: { action, state: 'reviewable', reasons: [], requiredAuthentication: null },
      configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'], observedAt: time(-1000), expiresAt: time(19_000),
      effectiveAuthority: false, financialState: null } as FinancialPolicyPreparation);
  }
  const observe = vi.fn(async () => structuredClone(observation));
  const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe, now: () => clock, newId: () => uuid(999) });
  const readers = { resolveObserver: vi.fn(async (): Promise<unknown> => structuredClone(scope)) };
  const authentication = { append: vi.fn(async (e: unknown): Promise<unknown> => ({ id: uuid(999), version: 1,
    recordHash: await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }) })) };
  const preparationReader = { prepare: vi.fn(async (_id: string, _scope: FinancialPolicyReaderScope, q: { selection: FinancialPolicyPreparationRequest }): Promise<unknown> => facts(q.selection.action)) };
  const dependencies = { environment: 'development' as const, issuer, verifier, readers, authentication, preparationReader, now: () => clock };
  const gateway = createFinancialPolicyPreparationGateway(dependencies);
  return { gateway, dependencies, observe, observation, scope, verifier, readers, authentication, preparationReader, selections, facts,
    mandate, budget, approval, draft, proposal, draftScope, asset, control, period, read, advance: (delta: number) => { clock += delta; } };
}
function decision(v: FinancialPolicyPreparation) {
  const result = structuredClone(v), reasons = financialPolicyPreparationReasons(result);
  result.decision = { action: result.selection.action, state: reasons.length ? 'blocked' : 'reviewable', reasons, requiredAuthentication: null };
  return FinancialPolicyPreparationSchema.parse(result);
}
async function rehash(v: FinancialPolicyRead, record: FinancialPolicyRecord) { return { ...v, record, reference: await financialPolicyRecordRef(record) }; }
const unknown = { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' }, expired = { code: 'FINANCIAL_POLICY_EXPIRED' };
const invoke = (f: Awaited<ReturnType<typeof fixture>>, action: FinancialPolicyPreparationRequest['action'] = 'save_document') =>
  f.gateway.prepare(token, action === 'save_draft' || action === 'withdraw_draft' ? rid : null, f.selections[action]);

describe('financial-policy preparation gateway with offline synthetic adapters', () => {
  it.each(['save_document', 'save_draft', 'withdraw_draft', 'propose_governance'] as const)('projects %s with one identity append and one preparation read', async action => {
    const f = await fixture(), result = await invoke(f, action);
    expect(result.decision).toEqual({ action, state: 'reviewable', reasons: [], requiredAuthentication: null });
    expect(result.observation).toEqual({ observedAt: time(-1000), expiresAt: time(19_000) });
    expect(result).toMatchObject({ effectiveAuthority: false, financialState: null });
    expect(FinancialPolicyPreparationResponseSchema.safeParse(result).success).toBe(true);
    expect(f.authentication.append).toHaveBeenCalledOnce(); expect(f.preparationReader.prepare).toHaveBeenCalledOnce();
    expect(f.authentication.append.mock.calls[0]?.[0]).toMatchObject({ kind: 'identity', purpose: 'financial_policy_observation' });
    expect(f.preparationReader.prepare.mock.calls[0]).toEqual([uuid(999), f.scope, { responsibilityId: result.responsibilityId, selection: f.selections[action] }]);
    expect(Object.keys(f.gateway)).toEqual(['prepare']);
    expect(JSON.stringify(result)).not.toMatch(/subject|sessionId|externalMembershipId|externalOrganizationId|identityEvidence|tokenHash|decisionNonce|originalActorMatches|mfaEvidence/);
  });
  it('retains expired raw draft/open revisions and separate stale historical text', async () => {
    const f = await fixture();
    for (const action of ['save_draft', 'propose_governance'] as const) {
      const v = f.facts(action);
      if (v.target.state !== 'exact') throw new Error('exact fixture');
      v.target.historicalDocuments = v.target.historicalDocuments.map(d => ({ ...d, current: false, state: 'SUPERSEDED' }));
      f.preparationReader.prepare.mockResolvedValue(v);
      const result = await invoke(f, action);
      expect(result.target.state === 'exact' && result.target.record.projection.state).toBe('EXPIRED');
      expect(result.target.historicalDocuments.every(d => !d.projection.currentRecord)).toBe(true);
      expect(result.decision.state).toBe('reviewable');
    }
  });
  it('withdraws against historical stale/expired material without replacing its scope or terms', async () => {
    const f = await fixture('operations'), v = f.facts('withdraw_draft');
    if (v.target.state !== 'exact') throw new Error('exact fixture');
    v.target.record.blockers = ['DRAFT_EXPIRED', 'DOCUMENT_CHANGED', 'SCOPE_CHANGED', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'];
    v.target.historicalDocuments[0] = { ...v.target.historicalDocuments[0]!, current: false, state: 'SUPERSEDED' };
    f.preparationReader.prepare.mockResolvedValue(v);
    const result = await invoke(f, 'withdraw_draft');
    expect(result.material).toEqual({ action: 'withdraw_draft' }); expect(result.decision.state).toBe('reviewable');
  });
  it.each(['unavailable', 'changed'] as const)('keeps %s targets blocked and opaque', async state => {
    const f = await fixture(), v = f.facts();
    v.target = { state, latestReference: state === 'changed' ? { id: v.selection.targetId, version: 1, recordHash: hash } : null,
      record: null, historicalDocuments: [], control: null } as FinancialPolicyPreparation['target'];
    f.preparationReader.prepare.mockResolvedValue(decision(v)); const result = await invoke(f);
    expect(result.target).toEqual({ state, latestReference: v.target.latestReference, record: null, historicalDocuments: [] });
    expect(result.decision.reasons).toEqual([state === 'changed' ? 'PREDECESSOR_CHANGED' : 'TARGET_UNAVAILABLE']);
  });
  it('permits document revision by original actor despite changed historical subject/session/version', async () => {
    const f = await fixture(), v = f.facts();
    const document = await rehash(f.budget, replace(f.budget.record, ['actor', 'subject'], 'historical_subject'));
    v.selection = { schemaVersion: 1, action: 'save_document', targetId: document.reference.id, previous: document.reference, purpose: 'budget_policy' };
    v.target = { state: 'exact', latestReference: document.reference, record: document, historicalDocuments: [], control: null }; v.originalActorMatches = true;
    f.preparationReader.prepare.mockResolvedValue(decision(v));
    expect((await f.gateway.prepare(token, null, v.selection)).decision.state).toBe('reviewable');
  });
  it.each(['save_draft', 'withdraw_draft', 'propose_governance'] as const)('blocks a reused public actor ID with a different original private subject for %s', async action => {
    const f = await fixture(), v = f.facts(action);
    if (v.target.state !== 'exact') throw new Error('exact fixture');
    let record = replace(v.target.record.record, ['actor', 'subject'], 'other_person');
    record = replace(record, [action === 'propose_governance' ? 'proposer' : 'requester', 'subject'], 'other_person');
    const raw = await rehash(v.target.record, record);
    v.target.record = raw; v.target.latestReference = raw.reference; v.selection.previous = raw.reference; v.originalActorMatches = false;
    f.preparationReader.prepare.mockResolvedValue(decision(v));
    const result = await f.gateway.prepare(token, v.responsibilityId, v.selection);
    expect(result.decision.reasons).toContain('ORIGINAL_ACTOR_REQUIRED');
  });
  it('blocks inherited optional draft references without dropping them and preserves withdrawal', async () => {
    const f = await fixture();
    for (const action of ['save_draft', 'withdraw_draft'] as const) {
      const v = f.facts(action); if (v.target.state !== 'exact') throw new Error('exact fixture');
      const raw = await rehash(v.target.record, replace(v.target.record.record, ['draft', 'asset'], f.asset.pin));
      v.target.record = raw; v.target.latestReference = raw.reference; v.selection.previous = raw.reference;
      f.preparationReader.prepare.mockResolvedValue(decision(v)); const response = await f.gateway.prepare(token, rid, v.selection);
      expect(response.decision.reasons).toEqual(action === 'save_draft' ? ['DRAFT_MATERIAL_UNSUPPORTED'] : []);
      expect(response.target.state === 'exact' && response.target.record.record.kind === 'draft' && response.target.record.record.draft.asset).toEqual(f.asset.pin);
    }
  });
  it('keeps finance organization disclosure blocked and rejects Operations before append/preparation', async () => {
    const finance = await fixture('finance'); expect((await invoke(finance)).decision.reasons).toEqual(['ROLE_REQUIRED']);
    const operations = await fixture('operations'); await expect(invoke(operations)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
    expect(operations.authentication.append).not.toHaveBeenCalled(); expect(operations.preparationReader.prepare).not.toHaveBeenCalled();
  });
  it('reports missing selections without inventing asset or document material', async () => {
    const f = await fixture(), v = f.facts('propose_governance');
    v.selection = { schemaVersion: 1, action: 'propose_governance', targetId: 'new_proposal', previous: null, assetKey: null, budgetDocument: null, approvalDocument: null };
    v.target = { state: 'absent', latestReference: null, record: null, historicalDocuments: [], control: null }; v.originalActorMatches = null;
    v.material = { action: 'propose_governance', asset: null, budgetAccountId: null, control: null, acceptedConfiguration: null, periods: [],
      budgetDocument: null, approvalDocument: null, eligibleActionSites: [] };
    f.preparationReader.prepare.mockResolvedValue(decision(v)); const response = await f.gateway.prepare(token, null, v.selection);
    expect(response.decision.reasons).toEqual(['ASSET_MISSING', 'DOCUMENT_REQUIRED', 'SITE_ACCESS_REQUIRED']); expect(response.material).toEqual(v.material);
  });
  it.each(['save_document', 'save_draft', 'withdraw_draft', 'propose_governance'] as const)('captures dependencies and %s selection before observation waits', async action => {
    const f = await fixture(), q = structuredClone(f.selections[action]), originalPrepare = f.preparationReader.prepare;
    f.dependencies.preparationReader.prepare = vi.fn(async () => { throw new Error('replacement'); });
    f.dependencies.environment = 'production' as 'development'; f.dependencies.issuer = 'https://other.invalid';
    f.observe.mockImplementation(async () => { q.targetId = 'mutated'; return structuredClone(f.observation); });
    const response = await f.gateway.prepare(token, action === 'save_draft' || action === 'withdraw_draft' ? rid : null, q);
    expect(response.selection).toEqual(f.selections[action]); expect(originalPrepare).toHaveBeenCalledOnce(); expect(f.preparationReader.prepare).not.toHaveBeenCalled();
  });
  it('isolates the expected selection/scope from injected reader argument mutation', async () => {
    const f = await fixture(); f.preparationReader.prepare.mockImplementation(async (_id, scope, query) => {
      const response = f.facts(); scope.actor.actorId = 'mutated'; query.selection.targetId = 'mutated'; return response;
    });
    expect((await invoke(f)).scope.actor.actorId).toBe('actor_a');
  });
  it('captures verifier, resolver, authentication and clock functions at construction', async () => {
    const f = await fixture(), originalAppend = f.authentication.append, originalResolve = f.readers.resolveObserver;
    f.verifier.observe = vi.fn(async () => { throw new Error('replaced verifier'); });
    f.verifier.identityEvidence = vi.fn(() => { throw new Error('replaced evidence'); });
    f.readers.resolveObserver = vi.fn(async () => { throw new Error('replaced resolver'); });
    f.authentication.append = vi.fn(async () => { throw new Error('replaced append'); });
    f.dependencies.now = () => at + 30_000;
    expect((await invoke(f)).decision.state).toBe('reviewable'); expect(originalAppend).toHaveBeenCalledOnce(); expect(originalResolve).toHaveBeenCalledOnce();
    expect(f.verifier.observe).not.toHaveBeenCalled(); expect(f.authentication.append).not.toHaveBeenCalled();
  });
  it.each([
    [['actor', 'actorId'], 'wrong'], [['actor', 'subject'], 'wrong'], [['environment'], 'production'], [['organizationId'], 'wrong'],
    [['externalOrganizationId'], 'wrong'], [['externalRole'], 'org:admin'], [['issuer'], 'https://other.invalid'], [['tokenHash'], hash],
    [['tokenIssuedAt'], time(-25_000)], [['observedAt'], time(-2_000)], [['sessionExpiresAt'], time(100_000)], [['expiresAt'], time(100_000)],
  ] as const)('rejects altered identity-only evidence binding %j before append', async (path, value) => {
    const f = await fixture(), evidence = f.verifier.identityEvidence.bind(f.verifier);
    f.verifier.identityEvidence = (observation, scope) => replace(evidence(observation, scope), [...path], value);
    const gateway = createFinancialPolicyPreparationGateway(f.dependencies);
    await expect(gateway.prepare(token, null, f.selections.save_document)).rejects.toMatchObject(unknown);
    expect(f.authentication.append).not.toHaveBeenCalled(); expect(f.preparationReader.prepare).not.toHaveBeenCalled();
  });
  it.each(['observe', 'resolve', 'append', 'prepare'] as const)('rejects original deadline consumed during %s without retries', async stage => {
    const f = await fixture();
    if (stage === 'observe') f.observe.mockImplementation(async () => { f.advance(20_000); return f.observation; });
    if (stage === 'resolve') f.readers.resolveObserver.mockImplementation(async () => { f.advance(20_000); return f.scope; });
    if (stage === 'append') f.authentication.append.mockImplementation(async () => { f.advance(20_000); return {}; });
    if (stage === 'prepare') f.preparationReader.prepare.mockImplementation(async () => { f.advance(20_000); return f.facts(); });
    await expect(invoke(f)).rejects.toMatchObject(expired); expect(f.preparationReader.prepare.mock.calls.length).toBeLessThanOrEqual(stage === 'prepare' ? 1 : 0);
  });
  it.each([
    [['scope', 'actor', 'actorId'], 'wrong'], [['scope', 'organizationId'], 'wrong'], [['selection', 'targetId'], 'wrong'],
    [['responsibilityId'], rid], [['originalActorMatches'], true], [['effectiveAuthority'], true], [['financialState'], {}],
    [['scope', 'actor', 'privateExtra'], 'secret'], [['observedAt'], time(1)], [['expiresAt'], time(20_000)],
    [['decision', 'state'], 'not_evaluated'], [['decision', 'reasons'], ['ELIGIBILITY_NOT_EVALUATED']],
  ] as const)('rejects private binding/schema contradiction %j', async (path, value) => {
    const f = await fixture(); f.preparationReader.prepare.mockResolvedValue(replace(f.facts(), [...path], value));
    await expect(invoke(f)).rejects.toMatchObject(unknown);
  });
  it.each(['record', 'text', 'authority', 'asset', 'account', 'period', 'sites', 'history'] as const)('rejects corrupted %s material', async mode => {
    const f = await fixture(), action = ['asset', 'account', 'period', 'sites'].includes(mode) ? 'propose_governance' : 'save_draft';
    let v = f.facts(action);
    if (mode === 'record') v = replace(v, ['target', 'record', 'record', 'createdAt'], time(-80_000));
    if (mode === 'text') v = replace(v, ['material', 'document', 'record', 'text'], 'Corrupt text');
    if (mode === 'authority') v = replace(v, ['material', 'draftScope', 'authorityHash'], hash);
    if (mode === 'asset') v = replace(v, ['material', 'asset', 'decimals'], 9);
    if (mode === 'account') v = replace(replace(v, ['material', 'budgetAccountId'], hash), ['material', 'control', 'budgetAccountId'], hash);
    if (mode === 'period') v = replace(v, ['material', 'periods', '0', 'id'], hash);
    if (mode === 'sites') v = replace(v, ['material', 'eligibleActionSites', '0', 'id'], 'foreign_site');
    if (mode === 'history') v = replace(v, ['target', 'historicalDocuments'], []);
    f.preparationReader.prepare.mockResolvedValue(v); await expect(invoke(f, action)).rejects.toMatchObject(unknown);
  });
  it.each(['id', 'version', 'recordHash'] as const)('verifies identity append %s before preparation', async field => {
    const f = await fixture(); f.authentication.append.mockResolvedValue({ id: uuid(999), version: 1, recordHash: hash, [field]: field === 'version' ? 2 : 'incorrect' });
    await expect(invoke(f)).rejects.toMatchObject(unknown); expect(f.preparationReader.prepare).not.toHaveBeenCalled();
  });
  it('rejects unknown request fields and wrong route scope before observing identity', async () => {
    const f = await fixture();
    await expect(f.gateway.prepare(token, rid, f.selections.save_document)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    await expect(f.gateway.prepare(token, null, { ...f.selections.save_document, nonce: 'forged' } as unknown as FinancialPolicyPreparationRequest)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INPUT_INVALID' });
    expect(f.observe).not.toHaveBeenCalled();
  });
  it('rejects a public response after its deadline and never echoes raw failures', async () => {
    const f = await fixture(), response = await invoke(f);
    await expect(validateFinancialPolicyPreparationResponse(null, f.selections.save_document, response, () => at + 19_000)).rejects.toMatchObject(unknown);
    for (const error of [new Error('secret provider URL'), { code: 'AUTH_REQUIRED', message: 'forged' }, new DomainError('constructor', 503, 'secret')])
      expect(safeFinancialPolicyPreparationApiError(error)).toEqual({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503, message: 'The financial-policy preparation could not be verified.' });
    expect(safeFinancialPolicyPreparationApiError(new DomainError('AUTH_REQUIRED', 503, 'private token'))).toEqual({ code: 'AUTH_REQUIRED', status: 401, message: 'Sign in again.' });
  });
  it('checks the original public response deadline again after hashing full material', async () => {
    const f = await fixture(), response = await invoke(f, 'save_draft'); let calls = 0;
    await expect(validateFinancialPolicyPreparationResponse(rid, f.selections.save_draft, response, () => ++calls === 1 ? at : at + 19_000)).rejects.toMatchObject(unknown);
    expect(calls).toBeGreaterThan(1);
  });
  it('preserves a shorter co-observed deadline without refreshing the identity', async () => {
    const f = await fixture(), v = f.facts(); v.expiresAt = time(5_000); f.preparationReader.prepare.mockResolvedValue(v);
    expect((await invoke(f)).observation).toEqual({ observedAt: time(-1000), expiresAt: time(5_000) }); expect(f.observe).toHaveBeenCalledOnce();
  });
  it('accepts a later coherent private observation without extending the original deadline', async () => {
    const f = await fixture(), v = f.facts(); v.observedAt = time(0); f.preparationReader.prepare.mockResolvedValue(v);
    const response = await invoke(f);
    expect(response.observation).toEqual({ observedAt: time(-1000), expiresAt: time(19_000) });
    expect(response.selection).toEqual(f.selections.save_document); expect(response.scope.actor).toEqual({ actorId: 'actor_a', membershipVersion: 9 });
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.preparationReader.prepare).toHaveBeenCalledOnce();
  });
  it('preserves original observation and expiry after a delayed private read', async () => {
    const f = await fixture(); f.preparationReader.prepare.mockImplementation(async () => {
      f.advance(5_000); const v = f.facts(); v.observedAt = time(5_000); return v;
    });
    expect((await invoke(f)).observation).toEqual({ observedAt: time(-1000), expiresAt: time(19_000) });
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.preparationReader.prepare).toHaveBeenCalledOnce();
  });
  it('preserves a shorter deadline from a later private observation', async () => {
    const f = await fixture(), v = f.facts(); v.observedAt = time(0); v.expiresAt = time(5_000); f.preparationReader.prepare.mockResolvedValue(v);
    expect((await invoke(f)).observation).toEqual({ observedAt: time(-1000), expiresAt: time(5_000) });
  });
  it.each([
    { observedAt: time(1), expiresAt: time(19_000) },
    { observedAt: time(0), expiresAt: time(20_000) },
    { observedAt: time(-10_000), expiresAt: time(-1) },
  ])('rejects future, extended or expired private timing %j', async timing => {
    const f = await fixture(); f.preparationReader.prepare.mockResolvedValue({ ...f.facts(), ...timing });
    await expect(invoke(f)).rejects.toMatchObject(unknown);
  });
  it.each(['scope', 'selection'] as const)('retains exact %s binding with a valid later private observation', async binding => {
    const f = await fixture(), v = f.facts(); v.observedAt = time(0);
    if (binding === 'scope') v.scope.actor.actorId = 'other_actor'; else v.selection.targetId = 'other_document';
    f.preparationReader.prepare.mockResolvedValue(v); await expect(invoke(f)).rejects.toMatchObject(unknown);
  });
});
