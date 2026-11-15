import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FINANCE_DEVNET_ASSET, decodeSolanaBase58, FinancialPolicyCommandSchema, FinancialPolicyRecordSchema, FinancialPolicyResultSchema,
  type FinancialPolicyActor, type FinancialPolicyCommand, type FinancialPolicyRecord, type FinancialPolicyResult,
  type FinancialPolicyRead, type Role } from '@pactwoven/contracts';
import { commandDigest, financialPolicyRecordRef, financialPolicyTextHash, financialPolicyCommandHash, physicalAssetKey,
  financialBudgetAccountId, financialBudgetPeriodId, financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash,
  financialPolicyDecisionIntent } from '@pactwoven/domain';
import type { FinancialPolicyContext, FinancialPolicyReaderScope } from '@pactwoven/db';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway, safeFinancialPolicyApiError, validateFinancialPolicyWire } from './financial-policy-service.js';

// These adapters are synthetic; no database, Clerk, wallet, factor or provider call is made.
const at = Date.parse('2026-11-15T12:00:00.000Z'), time = (delta: number) => new Date(at + delta).toISOString();
const token = 'synthetic.token.only', issuer = 'https://synthetic.invalid';
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const proof = (n: number) => ({ id: uuid(n), version: 1, recordHash: 'a'.repeat(64) });
const actor = (id = 'actor_a'): FinancialPolicyActor => ({ actorId: id, membershipVersion: 1, subject: `subject_${id}`,
  externalMembershipId: `membership_${id}`, sessionId: `session_${id}` });
type Pair = { command: FinancialPolicyCommand; result: FinancialPolicyResult };
function replace<T>(value: T, path: string[], replacement: unknown): T {
  const result = structuredClone(value); let parent = result as Record<string, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = replacement; return result;
}
async function fixture(role: Role = 'owner') {
  let clock = at;
  const person = actor(), scope: FinancialPolicyReaderScope = { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a',
    actor: { ...person, membershipVersion: 9, sessionId: 'current_session' }, organizationEpoch: 4, roles: [role], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const observation = { identity: { subject: person.subject, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic',
    externalMembershipId: person.externalMembershipId, externalRole: 'org:member', sessionId: 'current_session', membershipObservedAt: time(-1000), authenticatedAt: time(-60_000) },
    observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: time(-30_000), observedAt: time(-500), expiresAt: time(300_000) } };
  const authority = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', responsibility: {
    id: 'responsibility_a', version: 1, hash: 'b'.repeat(64), siteId: 'site_a' }, generation: 0, family: 'none' as const, legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }),
    site: { id: 'site_a', generation: 0, recordHash: 'c'.repeat(64) } };
  const asset = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: 'd'.repeat(64), financialUseEpoch: 0 };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key), control = { budgetAccountId, generation: 0, accepted: null };
  const hex = (value: string) => Buffer.from(decodeSolanaBase58(value, 32)).toString('hex');
  const assetContext = { pin: asset, genesisHex: hex(FINANCE_DEVNET_ASSET.genesis), tokenProgramHex: hex(FINANCE_DEVNET_ASSET.tokenProgram),
    mintHex: hex(FINANCE_DEVNET_ASSET.mint), decimals: 6, policy: 'solana-original-devnet-usdc-v1' };
  const pairs: Pair[] = [];
  const base = (kind: string, id: string, responsibilityId: string | null = null) => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    responsibilityId, organizationEpoch: 2, kind, id, previous: null, key: `original_${kind}_${id}` });
  const add = async (input: unknown, fields: object, a = person, evidence = proof(100 + pairs.length)): Promise<Pair> => {
    const command = FinancialPolicyCommandSchema.parse(input), operationId = uuid(200 + pairs.length);
    const body = FinancialPolicyRecordSchema.parse({ schemaVersion: 1, environment: command.environment, organizationId: command.organizationId,
      responsibilityId: command.responsibilityId, id: command.id, version: command.previous === null ? 1 : command.previous.version + 1, predecessor: command.previous,
      actor: a, identityEvidence: evidence, organizationEpoch: 2, operationId, createdAt: time(-100_000), ...fields });
    const result = FinancialPolicyResultSchema.parse({ schemaVersion: 1, id: operationId, environment: command.environment, organizationId: command.organizationId,
      actorId: a.actorId, responsibilityId: command.responsibilityId, kind: command.kind, key: command.key, commandHash: await financialPolicyCommandHash(a.actorId, command),
      target: await financialPolicyRecordRef(body), body, effectiveAuthority: false, financialState: null });
    const pair = { command, result }; pairs.push(pair); return pair;
  };
  const document = async (id: string, purpose: string, rid: string | null) => {
    const text = `Exact ${purpose} text.\nCafé 🧵`;
    return add({ ...base('save_document', id, rid), purpose, text }, { kind: 'document', purpose, text, contentHash: await financialPolicyTextHash(text) });
  };
  const mandate = await document('mandate_doc', 'financial_mandate', 'responsibility_a'), budget = await document('budget_doc', 'budget_policy', null),
    approval = await document('approval_doc', 'approval_policy', null);
  const draft = { scope: draftScope, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
    supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...mandate.result.target, purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null, startsAt: time(-100_000), expiresAt: time(300_000) };
  const saved = await add({ ...base('save_draft', 'draft_a', 'responsibility_a'), draft }, { kind: 'draft', state: 'DRAFT', requester: person, draft });
  const withdrawn = await add({ ...base('withdraw_draft', 'draft_a', 'responsibility_a'), previous: saved.result.target }, { kind: 'draft', state: 'WITHDRAWN', requester: person, draft });
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, time(-200_000), time(900_000)), startsAt: time(-200_000), endsAt: time(900_000) },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'],
      action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...approval.result.target, purpose: 'approval_policy' }, { ...budget.result.target, purpose: 'budget_policy' }] };
  const proposal = await add({ ...base('propose_governance', 'governance_a'), bundle, expectedControl: control, expiresAt: time(300_000) },
    { kind: 'governance', state: 'OPEN', proposer: person, bundle, expectedControl: control, decisionNonce: 'A'.repeat(43), expiresAt: time(300_000), decision: null });
  if (proposal.result.body.kind !== 'governance') throw new Error('Synthetic governance required.');
  const finance = actor('finance_a'), accept = { ...base('accept_governance', 'governance_a'), previous: proposal.result.target,
    expectedControl: control, nonce: 'A'.repeat(43), proposerEvidenceId: uuid(300), mfaEvidenceId: uuid(301) };
  const hashes = await financialPolicyDecisionIntent(proposal.result.body, finance, accept.key, 2);
  const accepted = await add(accept, { kind: 'governance', state: 'ACCEPTED', proposer: person, bundle, expectedControl: control,
    decisionNonce: accept.nonce, expiresAt: time(300_000), decision: { proposerObservation: proof(300), approverObservation: proof(302),
      mfaEvidence: proof(301), intentHash: hashes.intentHash, requestHash: hashes.requestHash } }, finance, proof(302));
  const rejected = await add({ ...base('reject_governance', 'governance_a'), previous: proposal.result.target, expectedControl: control, proposerEvidenceId: uuid(303) },
    { kind: 'governance', state: 'REJECTED', proposer: person, bundle, expectedControl: control, decisionNonce: 'A'.repeat(43), expiresAt: time(300_000),
      decision: { proposerObservation: proof(303), approverObservation: proof(304), mfaEvidence: null, intentHash: null, requestHash: null } }, person, proof(304));
  const asRead = (pair: Pair, current = true): FinancialPolicyRead => ({ record: pair.result.body, reference: pair.result.target, current,
    state: !current ? 'SUPERSEDED' : pair.result.body.kind === 'document' ? 'DOCUMENT' : pair.result.body.state,
    blockers: pair.result.body.kind === 'draft' ? ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE', ...(pair.result.body.state === 'WITHDRAWN' ? ['DRAFT_WITHDRAWN' as const] : [])] : [], effectiveAuthority: false });
  const baseContext = (rid: string | null, key: string | null = null): FinancialPolicyContext => ({ scope: structuredClone(scope), responsibilityId: rid,
    configurationVisibility: role === 'operations' ? 'references_only' : 'full', draftScope: rid === null ? null : structuredClone(draftScope),
    asset: key === null ? null : assetContext, control: key === null ? null : control, acceptedConfiguration: null, periods: [], documents: [],
    blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE', ...(key === null ? ['ASSET_MISSING' as const] : [])],
    observedAt: time(-1000), expiresAt: time(19_000), effectiveAuthority: false, financialState: null });
  const observe = vi.fn(async () => structuredClone(observation)), verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe, now: () => clock, newId: () => uuid(999) });
  const readers = {
    resolveObserver: vi.fn(async () => structuredClone(scope)),
    context: vi.fn(async (_e: string, _s: FinancialPolicyReaderScope, q: { responsibilityId: string | null; assetKey: string | null; documents: unknown[] }): Promise<unknown> => baseContext(q.responsibilityId, q.assetKey)),
    governance: vi.fn(async (): Promise<unknown> => ({ items: [{ policy: asRead(proposal), control, currentBudgetConfiguration: false }], nextId: null })),
    original: vi.fn(async (): Promise<unknown> => ({ command: mandate.command, result: mandate.result })),
  };
  const repository = {
    readFinancialPolicy: vi.fn(async (_e: string, q: { id: string; version: number | null }): Promise<unknown> => {
      const p = pairs.find(item => item.result.body.id === q.id && item.result.body.version === q.version); return p ? asRead(p) : null;
    }),
    listFinancialPolicyDrafts: vi.fn(async (): Promise<unknown> => ({ items: [asRead(saved)], nextId: null })),
  };
  const authentication = { append: vi.fn(async (e: unknown): Promise<unknown> => ({ id: uuid(999), version: 1,
    recordHash: await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }) })) };
  const dependencies = { environment: 'development' as const, issuer, verifier, readers, repository, authentication, now: () => clock };
  const gateway = createFinancialPolicyGateway(dependencies);
  const locator = async (pair = mandate) => {
    const s = { environment: pair.result.environment, organizationId: pair.result.organizationId, actorId: pair.result.actorId };
    const request = await financialPolicyHttpRequestFromStoredCommand(s, pair.command);
    return { responsibilityId: pair.result.responsibilityId, key: pair.command.key, kind: pair.command.kind, targetId: pair.command.id,
      publicRequestHash: await financialPolicyHttpRequestHash(s, request) };
  };
  return { gateway, dependencies, readers, repository, authentication, observe, observation, scope, pairs, mandate, budget, approval, saved, withdrawn, proposal, accepted, rejected,
    asRead, baseContext, asset, control, assetContext, bundle, locator, advance: (delta: number) => { clock += delta; } };
}
const unknown = { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' };
const denied = { code: 'FINANCIAL_POLICY_ACCESS_DENIED' };
const selector = (record: FinancialPolicyRecord) => ({ responsibilityId: record.responsibilityId, id: record.id, version: record.version, kind: record.kind });

describe('financial-policy read gateway with synthetic adapters', () => {
  it('returns bounded configuration-only context and appends identity-only evidence', async () => {
    const f = await fixture(), result = await f.gateway.context(token, null, null);
    expect(result).toMatchObject({ kind: 'organization', actions: [], effectiveAuthority: false, financialState: null,
      observation: { observedAt: time(-1000), expiresAt: time(19_000) } });
    expect(f.readers.context.mock.calls[0]?.[2]).toEqual({ responsibilityId: null, assetKey: null, documents: [] });
    expect(f.authentication.append.mock.calls[0]?.[0]).toMatchObject({ kind: 'identity', purpose: 'financial_policy_observation' });
    expect(JSON.stringify(result)).not.toMatch(/subject|sessionId|externalMembershipId|tokenHash|identityEvidence/);
    expect(Object.keys(f.gateway).sort()).toEqual(['context', 'get', 'index', 'recover']);
  });
  it('preserves Operations opaque accepted reference without governance-missing or body disclosure', async () => {
    const f = await fixture('operations'), raw = f.baseContext('responsibility_a', f.asset.key);
    raw.control = { ...f.control, generation: 1, accepted: f.accepted.result.target }; raw.blockers = raw.blockers.filter(b => b !== 'GOVERNANCE_MISSING');
    f.readers.context.mockResolvedValue(raw);
    const result = await f.gateway.context(token, 'responsibility_a', f.asset.key);
    expect(result).toMatchObject({ configurationVisibility: 'references_only', control: raw.control, acceptedConfiguration: null, periods: [], documents: [] });
    expect(result.blockers).not.toContain('GOVERNANCE_MISSING');
  });
  it('uses paired accepted control and validates physical asset and period provenance', async () => {
    const f = await fixture(), raw = f.baseContext(null, f.asset.key);
    raw.control = { ...f.control, generation: 1, accepted: f.accepted.result.target }; raw.acceptedConfiguration = f.asRead(f.accepted);
    raw.periods = [f.bundle.period]; raw.blockers = raw.blockers.filter(b => b !== 'GOVERNANCE_MISSING'); f.readers.context.mockResolvedValue(raw);
    const result = await f.gateway.context(token, null, f.asset.key);
    expect(result.acceptedConfiguration?.budgetConfiguration).toEqual({ status: 'observed', control: raw.control, currentBudgetConfiguration: true });
    expect(result.asset?.mint).toBe(FINANCE_DEVNET_ASSET.mint); expect(f.repository.readFinancialPolicy).not.toHaveBeenCalled();
  });
  it.each(['context', 'index', 'get', 'recover'] as const)('blocks Operations organization %s before disclosure adapters', async action => {
    const f = await fixture('operations');
    const call = action === 'context' ? f.gateway.context(token, null, null) : action === 'index' ? f.gateway.index(token, null, { afterId: null, limit: 20 }) :
      action === 'get' ? f.gateway.get(token, selector(f.budget.result.body)) : f.gateway.recover(token, await f.locator(f.budget));
    await expect(call).rejects.toMatchObject(denied);
    expect(f.authentication.append).not.toHaveBeenCalled(); expect(f.readers.context).not.toHaveBeenCalled(); expect(f.readers.governance).not.toHaveBeenCalled();
    expect(f.repository.readFinancialPolicy).not.toHaveBeenCalled(); expect(f.readers.original).not.toHaveBeenCalled();
  });
  it.each(['siteIds', 'actionSiteIds'] as const)('gates responsibility document reads by current %s before old repository access', async field => {
    const f = await fixture(); f.scope[field] = [];
    await expect(f.gateway.get(token, selector(f.mandate.result.body))).rejects.toMatchObject(denied);
    expect(f.repository.readFinancialPolicy).not.toHaveBeenCalled();
  });
  it('hydrates exact historical mandate text and leaves governance exact-version budget status unavailable', async () => {
    const f = await fixture('operations'), mandateRead = f.asRead(f.mandate, false);
    f.repository.readFinancialPolicy.mockImplementation(async (_e, q) => q.id === 'draft_a' ? f.asRead(f.saved) : mandateRead);
    const draft = await f.gateway.get(token, selector(f.saved.result.body));
    expect(draft.documents[0]?.projection.currentRecord).toBe(false); expect(draft.documents[0]?.record.text).toContain('financial_mandate');
    expect(f.repository.readFinancialPolicy.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ id: 'draft_a', version: 1 }), expect.objectContaining({ id: 'mandate_doc', version: 1 })]);
    const g = await fixture(), review = await g.gateway.get(token, selector(g.proposal.result.body));
    expect(review.policy.budgetConfiguration).toEqual({ status: 'unavailable', control: null, currentBudgetConfiguration: null });
    expect(review.documents.map(d => d.record.purpose)).toEqual(['approval_policy', 'budget_policy']);
    expect(g.readers.context).not.toHaveBeenCalled(); expect(g.readers.governance).not.toHaveBeenCalled();
  });
  it.each(['missing', 'hash', 'purpose', 'version', 'scope', 'text'] as const)('rejects incomplete or forged hydration: %s', async field => {
    const f = await fixture(), raw = f.asRead(f.mandate);
    const bad = field === 'missing' ? null : replace(raw, field === 'hash' ? ['reference', 'recordHash'] : ['record', field === 'scope' ? 'responsibilityId' : field],
      field === 'hash' ? 'f'.repeat(64) : field === 'purpose' ? 'budget_policy' : field === 'version' ? 2 : field === 'scope' ? 'other_responsibility' : 'Changed policy text');
    f.repository.readFinancialPolicy.mockImplementation(async (_e, q) => q.id === 'draft_a' ? f.asRead(f.saved) : bad);
    await expect(f.gateway.get(token, selector(f.saved.result.body))).rejects.toBeDefined();
  });
  it('lists bounded scoped drafts and coherent governance without document hydration', async () => {
    const f = await fixture(), drafts = await f.gateway.index(token, 'responsibility_a', { afterId: null, limit: 1 });
    expect(drafts.items[0]?.policy.record.kind).toBe('draft');
    const governance = await f.gateway.index(token, null, { afterId: null, limit: 1 });
    expect(governance.items[0]?.policy.budgetConfiguration).toEqual({ status: 'observed', control: f.control, currentBudgetConfiguration: false });
    expect(f.repository.readFinancialPolicy).not.toHaveBeenCalled(); expect(drafts.items[0]?.actions).toEqual([]);
  });
  it.each(['before_cursor', 'too_many', 'wrong_next', 'partial_next', 'wrong_kind', 'hash'] as const)('rejects malformed draft pages: %s', async mode => {
    const f = await fixture(), item = f.asRead(f.saved); let page: unknown = { items: [item], nextId: null };
    if (mode === 'too_many') page = { items: [item, item], nextId: null };
    if (mode === 'wrong_next') page = { items: [item], nextId: 'other' };
    if (mode === 'partial_next') page = { items: [item], nextId: item.record.id };
    if (mode === 'wrong_kind') page = { items: [f.asRead(f.mandate)], nextId: null };
    if (mode === 'hash') page = { items: [replace(item, ['reference', 'recordHash'], 'f'.repeat(64))], nextId: null };
    f.repository.listFinancialPolicyDrafts.mockResolvedValue(page);
    await expect(f.gateway.index(token, 'responsibility_a', { afterId: mode === 'before_cursor' ? 'draft_a' : null, limit: mode === 'partial_next' ? 2 : 1 })).rejects.toMatchObject(unknown);
  });
  it.each(['observe', 'resolve', 'append', 'context', 'list', 'read', 'original'] as const)('fails closed when %s wait expires', async point => {
    const f = await fixture(), delay = () => f.advance(20_000);
    if (point === 'observe') f.observe.mockImplementation(async () => { delay(); return structuredClone(f.observation); });
    if (point === 'resolve') f.readers.resolveObserver.mockImplementation(async () => { delay(); return structuredClone(f.scope); });
    if (point === 'append') f.authentication.append.mockImplementation(async () => { delay(); return {}; });
    if (point === 'context') f.readers.context.mockImplementation(async () => { delay(); return f.baseContext('responsibility_a'); });
    if (point === 'list') f.repository.listFinancialPolicyDrafts.mockImplementation(async () => { delay(); return { items: [], nextId: null }; });
    if (point === 'read') f.repository.readFinancialPolicy.mockImplementation(async () => { delay(); return null; });
    if (point === 'original') f.readers.original.mockImplementation(async () => { delay(); return null; });
    const pending = point === 'list' ? f.gateway.index(token, 'responsibility_a', { afterId: null, limit: 20 }) : point === 'read' ? f.gateway.get(token, selector(f.mandate.result.body)) :
      point === 'original' ? f.gateway.recover(token, await f.locator()) : f.gateway.context(token, 'responsibility_a', null);
    await expect(pending).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_EXPIRED' });
  });
  it.each([
    [['scope', 'actor', 'actorId'], 'other_actor'], [['draftScope', 'authorityHash'], 'f'.repeat(64)],
    [['configurationVisibility'], 'references_only'], [['documents'], [{}]], [['expiresAt'], time(20_001)],
    [['observedAt'], time(1)], [['blockers'], ['TRUST_UNAVAILABLE', 'FINANCIAL_AUTHORITY_UNAVAILABLE']],
    [['effectiveAuthority'], true],
  ] as [string[], unknown][])('rejects raw context forgery at %j', async (path, value) => {
    const f = await fixture(); f.readers.context.mockResolvedValue(replace(f.baseContext('responsibility_a'), path, value));
    await expect(f.gateway.context(token, 'responsibility_a', null)).rejects.toBeDefined();
  });
  it('rejects raw evidence/ref and observation forgeries before disclosure', async () => {
    const f = await fixture(); f.authentication.append.mockResolvedValue({ ...proof(999), recordHash: 'f'.repeat(64) });
    await expect(f.gateway.context(token, null, null)).rejects.toMatchObject(unknown); expect(f.readers.context).not.toHaveBeenCalled();
    const g = await fixture(); g.dependencies.verifier.identityEvidence = () => ({ verified: true });
    const fresh = createFinancialPolicyGateway(g.dependencies);
    await expect(fresh.context(token, null, null)).rejects.toMatchObject(unknown); expect(g.authentication.append).not.toHaveBeenCalled();
    const h = await fixture(); h.dependencies.verifier.observe = async () => replace(h.observation, ['observation', 'tokenHash'], 'f'.repeat(64));
    await expect(createFinancialPolicyGateway(h.dependencies).context(token, null, null)).rejects.toMatchObject(denied);
  });
  it('captures selectors/functions and protects local snapshots from callbacks', async () => {
    const f = await fixture(), selected = selector(f.mandate.result.body);
    f.readers.resolveObserver.mockImplementation(async (_environment?: unknown, observation?: unknown) => {
      if (observation) (observation as { identity: { subject: string } }).identity.subject = 'tampered';
      selected.id = 'changed_after_start'; return structuredClone(f.scope);
    });
    const read = f.repository.readFinancialPolicy; f.dependencies.repository.readFinancialPolicy = vi.fn(async () => { throw new Error('replacement'); });
    const result = await f.gateway.get(token, selected);
    expect(result.policy.record.id).toBe('mandate_doc'); expect(read).toHaveBeenCalled();
    expect(f.dependencies.repository.readFinancialPolicy).not.toHaveBeenCalled();
  });
  it('recovers exact originals with historical membership/session without reading current state', async () => {
    const f = await fixture();
    for (const pair of [f.mandate, f.saved, f.withdrawn, f.proposal, f.rejected]) {
      f.readers.original.mockResolvedValue(pair);
      const result = await f.gateway.recover(token, await f.locator(pair));
      expect(result.status).toBe('recorded'); expect(result.scope.actor.membershipVersion).toBe(9);
      expect(result.receipt?.actor.membershipVersion).toBe(1); expect(result.receipt?.publicRequestHash).toBe(result.publicRequestHash);
      expect(JSON.stringify(result)).not.toMatch(/sessionId|identityEvidence|commandHash|decisionNonce|mfaEvidence|intentHash/);
    }
    expect(f.readers.context).not.toHaveBeenCalled(); expect(f.repository.readFinancialPolicy).not.toHaveBeenCalled(); expect(f.readers.governance).not.toHaveBeenCalled();
  });
  it.each([
    [['result', 'body', 'actor', 'actorId'], 'other_actor'], [['result', 'body', 'actor', 'subject'], 'other_subject'],
    [['result', 'body', 'actor', 'externalMembershipId'], 'other_membership'], [['result', 'key'], 'other_original_key'],
    [['result', 'kind'], 'save_draft'], [['result', 'target', 'recordHash'], 'f'.repeat(64)],
    [['result', 'body', 'id'], 'other_target'], [['command', 'text'], 'changed terms'], [['result', 'commandHash'], 'f'.repeat(64)],
  ] as [string[], unknown][])('never turns corrupted original at %j into absence or success', async (path, value) => {
    const f = await fixture(); f.readers.original.mockResolvedValue(replace(f.mandate, path, value));
    await expect(f.gateway.recover(token, await f.locator())).rejects.toMatchObject(unknown);
  });
  it('requires public digest and reserves not_recorded for a completed null original lookup', async () => {
    const f = await fixture(), q = await f.locator();
    await expect(f.gateway.recover(token, { ...q, publicRequestHash: f.mandate.result.commandHash })).rejects.toMatchObject(unknown);
    f.readers.original.mockResolvedValue(null); expect(await f.gateway.recover(token, q)).toMatchObject({ status: 'not_recorded', receipt: null });
    for (const raw of [undefined, {}, { success: true }]) { f.readers.original.mockResolvedValue(raw); await expect(f.gateway.recover(token, q)).rejects.toMatchObject(unknown); }
    f.readers.original.mockRejectedValue(new Error('private supplier policy SQL details'));
    try { await f.gateway.recover(token, q); } catch (error) { expect(safeFinancialPolicyApiError(error)).toEqual({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503, message: 'The financial-policy response could not be verified.' }); }
  });
  it('recovers accepted historical consent without obtaining or renewing any factor', async () => {
    const f = await fixture('finance'), historical = f.accepted.result.body.actor;
    f.scope.actor = { ...historical, membershipVersion: 9, sessionId: 'current_session' };
    f.observation.identity.subject = historical.subject; f.observation.identity.externalMembershipId = historical.externalMembershipId;
    f.readers.original.mockResolvedValue(f.accepted);
    const result = await f.gateway.recover(token, await f.locator(f.accepted));
    expect(result.receipt?.kind).toBe('accept_governance'); expect(result.receipt?.actor.membershipVersion).toBe(1);
    expect(result.scope.actor.membershipVersion).toBe(9); expect(f.readers.context).not.toHaveBeenCalled();
    expect(f.authentication.append).toHaveBeenCalledOnce();
    expect(f.authentication.append.mock.calls[0]?.[0]).toMatchObject({ kind: 'identity', purpose: 'financial_policy_observation' });
  });
  it('bounds encoded response bytes, including escaped Unicode, at two MiB', () => {
    const schema = z.strictObject({ text: z.string() });
    const small = { text: 'a'.repeat(1024) }; expect(validateFinancialPolicyWire(schema, small)).toEqual(small);
    expect(() => validateFinancialPolicyWire(schema, { text: 'a'.repeat(2 * 1024 * 1024) })).toThrow();
    expect(() => validateFinancialPolicyWire(schema, { text: '\u2028🧵'.repeat(400_000) })).toThrow();
  });
  it.each([
    [['asset', 'pin', 'key'], 'f'.repeat(64)], [['asset', 'mintHex'], 'f'.repeat(64)], [['asset', 'decimals'], 9],
    [['control', 'budgetAccountId'], 'f'.repeat(64)], [['periods', '0', 'id'], 'f'.repeat(64)],
    [['acceptedConfiguration', 'reference', 'recordHash'], 'f'.repeat(64)],
  ] as [string[], unknown][])('rejects coherent-context material forgery at %j', async (path, value) => {
    const f = await fixture(), raw = f.baseContext(null, f.asset.key);
    raw.control = { ...f.control, generation: 1, accepted: f.accepted.result.target }; raw.acceptedConfiguration = f.asRead(f.accepted);
    raw.periods = [f.bundle.period]; raw.blockers = raw.blockers.filter(b => b !== 'GOVERNANCE_MISSING');
    f.readers.context.mockResolvedValue(replace(raw, path, value));
    await expect(f.gateway.context(token, null, f.asset.key)).rejects.toBeDefined();
  });
});
