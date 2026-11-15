import { describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, FinancialPolicyCommandSchema, FinancialPolicyRecordSchema, FinancialPolicyResultSchema,
  type FinancialPolicyActor, type FinancialPolicyCommand, type FinancialPolicyRecord, type FinancialPolicyResult } from '@pactwoven/contracts';
import { projectFinancialPolicyHttpRecord, projectFinancialPolicyHttpView, projectFinancialPolicyHttpReceipt } from './financial-policy-responses.js';
import { financialBudgetAccountId, financialBudgetPeriodId, financialPolicyCommandHash, financialPolicyRecordRef,
  financialPolicyTextHash, financialPolicyDecisionIntent } from './financial-policies.js';
import { financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash } from './financial-policy-http.js';
import { commandDigest, canonicalJson } from './canonical.js';
import { physicalAssetKey } from './finance-provenance.js';

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const proof = (n: number) => ({ id: uuid(n), version: 1, recordHash: 'a'.repeat(64) });
const person = (id: string): FinancialPolicyActor => ({ actorId: id, membershipVersion: 1, subject: `subject_${id}`,
  externalMembershipId: `member_${id}`, sessionId: `session_${id}` });
const owner = person('owner_a'), finance = person('finance_a');
const startsAt = '2026-11-15T00:00:00.000Z', endsAt = '2026-11-22T00:00:00.000Z', expiresAt = '2026-11-16T00:00:00.000Z';
type Pair = { command: FinancialPolicyCommand; result: FinancialPolicyResult };
async function fixtures(): Promise<Pair[]> {
  const pairs: Pair[] = [];
  const base = (kind: string, id: string, responsibilityId: string | null = null) => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    responsibilityId, organizationEpoch: 2, kind, id, previous: null, key: `original_${kind}_${id}` });
  const add = async (input: unknown, a: FinancialPolicyActor, fields: object, identity = proof(100 + pairs.length)): Promise<Pair> => {
    const command = FinancialPolicyCommandSchema.parse(input), operationId = uuid(200 + pairs.length);
    const body = FinancialPolicyRecordSchema.parse({ schemaVersion: 1, environment: command.environment, organizationId: command.organizationId,
      responsibilityId: command.responsibilityId, id: command.id, version: command.previous === null ? 1 : command.previous.version + 1,
      predecessor: command.previous, actor: a, identityEvidence: identity, organizationEpoch: command.organizationEpoch,
      operationId, createdAt: startsAt, ...fields });
    const result = FinancialPolicyResultSchema.parse({ schemaVersion: 1, id: operationId, environment: command.environment, organizationId: command.organizationId,
      actorId: a.actorId, responsibilityId: command.responsibilityId, kind: command.kind, key: command.key,
      commandHash: await financialPolicyCommandHash(a.actorId, command), target: await financialPolicyRecordRef(body), body,
      effectiveAuthority: false, financialState: null });
    const pair = { command, result }; pairs.push(pair); return pair;
  };
  const document = async (id: string, purpose: string, responsibilityId: string | null) => {
    const text = `Exact ${purpose} terms.\nCafé 🧵`;
    return add({ ...base('save_document', id, responsibilityId), purpose, text }, owner,
      { kind: 'document', purpose, text, contentHash: await financialPolicyTextHash(text) });
  };
  const budget = await document('budget_doc', 'budget_policy', null), mandate = await document('mandate_doc', 'financial_mandate', 'responsibility_a'),
    approval = await document('approval_doc', 'approval_policy', null);
  const authority = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibility: { id: 'responsibility_a', version: 1,
    hash: 'b'.repeat(64), siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draft = { scope: { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }),
    site: { id: 'site_a', generation: 0, recordHash: 'c'.repeat(64) } },
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...mandate.result.target, purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null, startsAt, expiresAt };
  const saved = await add({ ...base('save_draft', 'draft_a', 'responsibility_a'), draft }, owner, { kind: 'draft', state: 'DRAFT', requester: owner, draft });
  await add({ ...base('withdraw_draft', 'draft_a', 'responsibility_a'), previous: saved.result.target },
    { ...owner, membershipVersion: 2, sessionId: 'replacement_session' }, { kind: 'draft', state: 'WITHDRAWN', requester: owner, draft });
  const asset = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: 'd'.repeat(64), financialUseEpoch: 0 };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key), expectedControl = { budgetAccountId, generation: 0, accepted: null };
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '18446744073709551615' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, startsAt, endsAt), startsAt, endsAt },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true,
      actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...approval.result.target, purpose: 'approval_policy' }, { ...budget.result.target, purpose: 'budget_policy' }] };
  const proposal = await add({ ...base('propose_governance', 'governance_a'), bundle, expectedControl, expiresAt }, owner,
    { kind: 'governance', state: 'OPEN', proposer: owner, bundle, expectedControl, decisionNonce: 'A'.repeat(43), expiresAt, decision: null });
  if (proposal.result.body.kind !== 'governance') throw new Error('Expected fixture proposal.');
  const accept = { ...base('accept_governance', 'governance_a'), previous: proposal.result.target, expectedControl,
    nonce: proposal.result.body.decisionNonce, proposerEvidenceId: uuid(300), mfaEvidenceId: uuid(301) };
  const hashes = await financialPolicyDecisionIntent(proposal.result.body, finance, accept.key, 2);
  await add(accept, finance, { kind: 'governance', state: 'ACCEPTED', proposer: owner, bundle, expectedControl, decisionNonce: accept.nonce, expiresAt,
    decision: { proposerObservation: proof(300), approverObservation: proof(302), mfaEvidence: proof(301), intentHash: hashes.intentHash, requestHash: hashes.requestHash } }, proof(302));
  await add({ ...base('reject_governance', 'governance_a'), previous: proposal.result.target, expectedControl, proposerEvidenceId: uuid(303) }, owner,
    { kind: 'governance', state: 'REJECTED', proposer: owner, bundle, expectedControl, decisionNonce: accept.nonce, expiresAt,
      decision: { proposerObservation: proof(303), approverObservation: proof(304), mfaEvidence: null, intentHash: null, requestHash: null } }, proof(304));
  return pairs;
}
const selector = (r: FinancialPolicyRecord) => ({ environment: r.environment, organizationId: r.organizationId, responsibilityId: r.responsibilityId, id: r.id, version: r.version });
async function expected(pair: Pair) {
  const scope = { environment: pair.result.environment, organizationId: pair.result.organizationId, actorId: pair.result.actorId };
  const request = await financialPolicyHttpRequestFromStoredCommand(scope, pair.command);
  return { scope, request, publicRequestHash: await financialPolicyHttpRequestHash(scope, request) };
}
const replace = (input: unknown, path: string[], value: unknown) => {
  const copy = structuredClone(input) as Record<string, unknown>; let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = value; return copy;
};
const forbidden = new Set(['subject', 'sessionId', 'externalMembershipId', 'identityEvidence', 'decisionNonce', 'decision',
  'proposerObservation', 'approverObservation', 'mfaEvidence', 'proposerEvidenceId', 'mfaEvidenceId', 'intentHash', 'requestHash', 'commandHash']);
function privateKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [...(forbidden.has(key) ? [key] : []), ...privateKeys(child)]);
}
const unknownOutcome = { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503 };

describe('financial policy public response projection', () => {
  it.each(['withdraw_draft', 'accept_governance', 'reject_governance'] as const)('rejects rehashed initial terminal %s before record or view redaction', async kind => {
    const pair = (await fixtures()).find(p => p.command.kind === kind)!;
    const impossible = FinancialPolicyRecordSchema.parse({ ...pair.result.body, version: 1, predecessor: null });
    const reference = await financialPolicyRecordRef(impossible);
    const read = (record: FinancialPolicyRecord, target: typeof reference) => ({ record, reference: target, current: true,
      state: record.kind === 'document' ? 'DOCUMENT' : record.state,
      blockers: record.kind === 'draft' ? ['DRAFT_WITHDRAWN', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] : [], effectiveAuthority: false });
    const budget = impossible.kind === 'governance' ? { status: 'unavailable', control: null, currentBudgetConfiguration: null } : null;
    await expect(projectFinancialPolicyHttpRecord(selector(impossible), impossible, reference)).rejects.toMatchObject(unknownOutcome);
    await expect(projectFinancialPolicyHttpView(selector(impossible), read(impossible, reference), budget)).rejects.toMatchObject(unknownOutcome);
    const valid = await projectFinancialPolicyHttpRecord(selector(pair.result.body), pair.result.body, pair.result.target);
    expect(valid.predecessor).toEqual(pair.result.body.predecessor); expect(valid.version).toBe(2);
    expect((await projectFinancialPolicyHttpView(selector(pair.result.body), read(pair.result.body, pair.result.target), budget)).record).toEqual(valid);
  });
  it('validates and projects both document scopes and all six exact original command kinds', async () => {
    const pairs = await fixtures(); expect(new Set(pairs.map(p => p.command.kind)).size).toBe(6);
    for (const pair of pairs) {
      const expectation = await expected(pair), before = canonicalJson(pair);
      const receipt = await projectFinancialPolicyHttpReceipt(expectation, pair.command, pair.result);
      expect(receipt).toMatchObject({ kind: pair.command.kind, operationId: pair.result.id, key: pair.command.key,
        publicRequestHash: expectation.publicRequestHash, target: pair.result.target, effectiveAuthority: false, financialState: null });
      expect(receipt.record).toEqual(await projectFinancialPolicyHttpRecord(selector(pair.result.body), pair.result.body, pair.result.target));
      expect(privateKeys(receipt)).toEqual([]); expect(receipt).not.toHaveProperty('currentRecord'); expect(receipt).not.toHaveProperty('actions');
      expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.record.actor)).toBe(true); expect(canonicalJson(pair)).toBe(before);
      expect(receipt.publicRequestHash).not.toBe(pair.result.commandHash);
    }
  });
  it('preserves complete maximal Unicode text and exact document content hash without hashing the redacted record as original', async () => {
    const pair = (await fixtures())[0]!; const text = '🧵'.repeat(19_999) + 'é';
    const command = FinancialPolicyCommandSchema.parse({ ...pair.command, text });
    const body = FinancialPolicyRecordSchema.parse({ ...pair.result.body, text, contentHash: await financialPolicyTextHash(text) });
    const result = { ...pair.result, body, target: await financialPolicyRecordRef(body), commandHash: await financialPolicyCommandHash(pair.result.actorId, command) };
    const receipt = await projectFinancialPolicyHttpReceipt(await expected({ command, result }), command, result);
    expect(receipt.record).toMatchObject({ text, contentHash: await financialPolicyTextHash(text) });
    expect(receipt.target.recordHash).not.toBe(await commandDigest({ namespace: 'pactwoven:financial-policy-document:v1', record: receipt.record }));
  });
  it('retains historical requester membership while a withdrawal actor uses a later session/version', async () => {
    const pair = (await fixtures()).find(p => p.command.kind === 'withdraw_draft')!;
    const receipt = await projectFinancialPolicyHttpReceipt(await expected(pair), pair.command, pair.result);
    expect(receipt.record).toMatchObject({ requester: { actorId: owner.actorId, membershipVersion: 1 }, actor: { actorId: owner.actorId, membershipVersion: 2 } });
  });
  it('preserves draft authority hashes while removing only duplicate private envelope scope', async () => {
    const pair = (await fixtures()).find(p => p.command.kind === 'save_draft')!;
    const value = await projectFinancialPolicyHttpRecord(selector(pair.result.body), pair.result.body, pair.result.target);
    if (value.kind !== 'draft' || pair.result.body.kind !== 'draft') throw new Error('Expected drafts.');
    expect(value.draft.scope.authority).not.toHaveProperty('environment'); expect(value.draft.scope.authority).not.toHaveProperty('organizationId');
    expect(value.draft.scope.authorityHash).toBe(pair.result.body.draft.scope.authorityHash); expect(value.draft.trust).toBeNull();
  });
  it('keeps unavailable, superseded, historical accepted and current budget observations distinct', async () => {
    const pairs = await fixtures(), open = pairs.find(p => p.command.kind === 'propose_governance')!, accepted = pairs.find(p => p.command.kind === 'accept_governance')!;
    if (open.result.body.kind !== 'governance') throw new Error('Expected governance.');
    const control = { budgetAccountId: open.result.body.bundle.budgetAccountId, generation: 1, accepted: accepted.result.target };
    const unavailable = await projectFinancialPolicyHttpView(selector(open.result.body), { record: open.result.body, reference: open.result.target,
      current: true, state: 'OPEN', blockers: [], effectiveAuthority: false }, { status: 'unavailable', control: null, currentBudgetConfiguration: null });
    expect(unavailable.budgetConfiguration?.currentBudgetConfiguration).toBeNull();
    const superseded = await projectFinancialPolicyHttpView(selector(open.result.body), { record: open.result.body, reference: open.result.target,
      current: false, state: 'SUPERSEDED', blockers: [], effectiveAuthority: false }, { status: 'observed', control, currentBudgetConfiguration: false });
    expect(superseded.projection).toMatchObject({ currentRecord: false, state: 'SUPERSEDED' });
    for (const current of [true, false]) {
      const budgetControl = current ? control : { ...control, generation: 2, accepted: { id: 'other_governance', version: 2, recordHash: 'f'.repeat(64) } };
      const value = await projectFinancialPolicyHttpView(selector(accepted.result.body), { record: accepted.result.body, reference: accepted.result.target,
        current: true, state: 'ACCEPTED', blockers: [], effectiveAuthority: false }, { status: 'observed', control: budgetControl, currentBudgetConfiguration: current });
      expect(value.projection.currentRecord).toBe(true); expect(value.budgetConfiguration?.currentBudgetConfiguration).toBe(current);
    }
    await expect(projectFinancialPolicyHttpView(selector(open.result.body), { record: open.result.body, reference: open.result.target,
      current: true, state: 'OPEN', blockers: [], effectiveAuthority: false }, { status: 'observed', control, currentBudgetConfiguration: false })).rejects.toMatchObject(unknownOutcome);
  });
  it('accepts expired current OPEN and normalizes duplicate diagnostics without removing distinct draft blockers', async () => {
    const pairs = await fixtures(), open = pairs.find(p => p.command.kind === 'propose_governance')!, draft = pairs.find(p => p.command.kind === 'save_draft')!;
    const value = await projectFinancialPolicyHttpView(selector(open.result.body), { record: open.result.body, reference: open.result.target,
      current: true, state: 'EXPIRED', blockers: [], effectiveAuthority: false }, { status: 'unavailable', control: null, currentBudgetConfiguration: null });
    expect(value.projection).toMatchObject({ currentRecord: true, state: 'EXPIRED' });
    const blockers = ['TRUST_UNAVAILABLE', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'DOCUMENT_CHANGED', 'DOCUMENT_CHANGED'];
    const d = await projectFinancialPolicyHttpView(selector(draft.result.body), { record: draft.result.body, reference: draft.result.target,
      current: true, state: 'DRAFT', blockers, effectiveAuthority: false }, null);
    expect(d.projection.blockers).toEqual(['DOCUMENT_CHANGED', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE']);
  });
  it('rejects changed selectors and malformed/hash-corrupt private records before projecting', async () => {
    const pair = (await fixtures())[0]!, s = selector(pair.result.body);
    for (const bad of [{ ...s, organizationId: 'other' }, { ...s, responsibilityId: 'other' }, { ...s, version: 2 }, { ...s, id: 'other' }, { ...s, verified: true }])
      await expect(projectFinancialPolicyHttpRecord(bad, pair.result.body, pair.result.target)).rejects.toMatchObject(unknownOutcome);
    for (const path of [['actor', 'sessionId'], ['actor', 'subject'], ['identityEvidence', 'recordHash'], ['text'], ['contentHash']])
      await expect(projectFinancialPolicyHttpRecord(s, replace(pair.result.body, path, path.at(-1)!.includes('Hash') ? 'f'.repeat(64) : 'changed'), pair.result.target)).rejects.toMatchObject(unknownOutcome);
  });
  it('checks removed actor/evidence relationships even when a malformed response has recomputed raw hashes', async () => {
    const pairs = await fixtures(), accepted = pairs.find(p => p.command.kind === 'accept_governance')!, draft = pairs.find(p => p.command.kind === 'save_draft')!;
    const cases: [Pair, string[], unknown][] = [
      [accepted, ['decision', 'approverObservation'], proof(900)], [accepted, ['decision', 'intentHash'], 'f'.repeat(64)],
      [accepted, ['decision', 'requestHash'], 'f'.repeat(64)], [accepted, ['proposer', 'subject'], 'changed_subject'],
      [accepted, ['actor', 'subject'], owner.subject], [draft, ['requester', 'sessionId'], 'different_session'],
    ];
    for (const [pair, path, value] of cases) {
      const body = FinancialPolicyRecordSchema.parse(replace(pair.result.body, path, value));
      const result = { ...pair.result, body, target: await financialPolicyRecordRef(body) };
      await expect(projectFinancialPolicyHttpReceipt(await expected(pair), pair.command, result)).rejects.toMatchObject(unknownOutcome);
    }
  });
  it('rejects scope, key, target, body, private evidence, nonce and public intent substitutions', async () => {
    const pairs = await fixtures();
    for (const pair of pairs) {
      const e = await expected(pair);
      for (const result of [replace(pair.result, ['commandHash'], 'f'.repeat(64)), replace(pair.result, ['target', 'recordHash'], 'f'.repeat(64)),
        replace(pair.result, ['id'], uuid(999)), replace(pair.result, ['key'], 'changed_original_key'), replace(pair.result, ['effectiveAuthority'], true)])
        await expect(projectFinancialPolicyHttpReceipt(e, pair.command, result)).rejects.toMatchObject(unknownOutcome);
      await expect(projectFinancialPolicyHttpReceipt({ ...e, publicRequestHash: 'f'.repeat(64) }, pair.command, pair.result)).rejects.toMatchObject(unknownOutcome);
      await expect(projectFinancialPolicyHttpReceipt({ ...e, scope: { ...e.scope, actorId: 'other' } }, pair.command, pair.result)).rejects.toMatchObject(unknownOutcome);
      if (pair.command.kind === 'accept_governance' || pair.command.kind === 'reject_governance') {
        const command = { ...pair.command, proposerEvidenceId: uuid(998) };
        const result = { ...pair.result, commandHash: await financialPolicyCommandHash(pair.result.actorId, command) };
        await expect(projectFinancialPolicyHttpReceipt(e, command, result)).rejects.toMatchObject(unknownOutcome);
      }
      if (pair.command.kind === 'accept_governance') {
        for (const command of [{ ...pair.command, nonce: 'B'.repeat(42) + 'A' }, { ...pair.command, mfaEvidenceId: uuid(997) }]) {
          const result = { ...pair.result, commandHash: await financialPolicyCommandHash(pair.result.actorId, command) };
          await expect(projectFinancialPolicyHttpReceipt(e, command, result)).rejects.toMatchObject(unknownOutcome);
        }
        if (pair.result.body.kind !== 'governance') throw new Error('Expected governance.');
        expect(e.publicRequestHash).not.toBe(pair.result.body.decision?.requestHash);
      }
    }
  });
  it('snapshots all private/public inputs before the first asynchronous digest', async () => {
    const pair = structuredClone((await fixtures())[0]!), e = structuredClone(await expected(pair));
    const pending = projectFinancialPolicyHttpReceipt(e, pair.command, pair.result);
    if (pair.command.kind !== 'save_document' || e.request.kind !== 'save_document') throw new Error('Expected documents.');
    pair.command.text = 'Changed after dispatch'; e.request.input.text = 'Changed public input'; pair.result.body.actor.subject = 'changed_actor';
    const receipt = await pending;
    expect(receipt.record).toMatchObject({ text: 'Exact budget_policy terms.\nCafé 🧵' });
  });
  it('does not create an alternate receipt route for an unsupported historical command ID', async () => {
    const pair = (await fixtures()).find(p => p.command.kind === 'propose_governance')!, e = await expected(pair);
    const command = FinancialPolicyCommandSchema.parse({ ...pair.command, id: 'context' });
    const body = FinancialPolicyRecordSchema.parse({ ...pair.result.body, id: 'context' });
    const result = { ...pair.result, body, target: await financialPolicyRecordRef(body), commandHash: await financialPolicyCommandHash(pair.result.actorId, command) };
    // Its exact immutable record can still be inspected; no HTTP0 mutation route is invented.
    expect((await projectFinancialPolicyHttpRecord(selector(body), body, result.target)).id).toBe('context');
    await expect(projectFinancialPolicyHttpReceipt(e, command, result)).rejects.toMatchObject(unknownOutcome);
  });
  it('rejects structurally valid historical trust instead of deleting it to produce a public draft', async () => {
    const pair = (await fixtures()).find(p => p.command.kind === 'save_draft')!;
    if (pair.result.body.kind !== 'draft') throw new Error('Expected draft.');
    const asset = { key: 'b'.repeat(64), version: 1, recordHash: 'a'.repeat(64), financialUseEpoch: 0 }, account = { ...asset, key: 'c'.repeat(64) };
    const qualification = (kind: string) => ({ kind, id: `qualification_${kind}`, version: 1, recordHash: 'a'.repeat(64), control: { key: 'd'.repeat(64), epoch: 1 } });
    const trust = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', asset, account,
      assetQualification: qualification('asset'), custodyQualification: qualification('custody'),
      sources: [{ id: 'source_a', version: 1, recordHash: 'a'.repeat(64), financialUseEpoch: 0,
        binding: { accountKey: account.key, recordHash: 'a'.repeat(64), financialUseEpoch: 0 }, qualification: qualification('source') }] };
    const body = FinancialPolicyRecordSchema.parse({ ...pair.result.body, draft: { ...pair.result.body.draft, asset, account, trust } });
    await expect(projectFinancialPolicyHttpRecord(selector(body), body, await financialPolicyRecordRef(body))).rejects.toMatchObject(unknownOutcome);
  });
  it('projects the immutable historical receipt after expiry without extending dates or obtaining new proof', async () => {
    const pair = (await fixtures()).find(p => p.command.kind === 'accept_governance')!, e = await expected(pair);
    const before = await projectFinancialPolicyHttpReceipt(e, pair.command, pair.result);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    try {
      expect(await projectFinancialPolicyHttpReceipt(e, pair.command, pair.result)).toEqual(before);
      expect(before).not.toHaveProperty('observation');
    } finally { vi.useRealTimers(); }
  });
});
