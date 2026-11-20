import { describe, expect, it } from 'vitest';
import { FinancialPolicyCommandSchema, FinancialPolicyHttpRequestSchema, type FinancialPolicyCommand, type FinancialPolicyHttpRequest } from '@pactwoven/contracts';
import { financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash,
  snapshotFinancialPolicyHttpRequest, FINANCIAL_POLICY_HTTP_REQUEST_NAMESPACE } from './financial-policy-http.js';
import { financialBudgetAccountId, financialBudgetPeriodId, financialPolicyCommandHash } from './financial-policies.js';
import { DomainError } from './errors.js';

const scope = () => ({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a' });
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) :
  Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), b => b.toString(16).padStart(2, '0')).join('');
const ref = (id = 'policy_a') => ({ id, version: 1, recordHash: 'a'.repeat(64) });
const pin = (key = 'b'.repeat(64)) => ({ key, version: 1, recordHash: 'c'.repeat(64), financialUseEpoch: 0 });
async function commands(): Promise<FinancialPolicyCommand[]> {
  const asset = pin(), budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key);
  const startsAt = '2026-11-15T00:00:00.000Z', endsAt = '2026-11-22T00:00:00.000Z';
  const expectedControl = { budgetAccountId, generation: 0, accepted: null };
  const authority = { schemaVersion: 1, environment: 'development', organizationId: 'org_a',
    responsibility: { id: 'responsibility_a', version: 1, hash: 'd'.repeat(64), siteId: 'site_a' }, generation: 3,
    family: 'legacy', legacyHead: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 2, hash: 'e'.repeat(64), state: 'PAUSED' } };
  const draft = { scope: { authority, authorityHash: await digest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }),
    site: { id: 'site_a', generation: 0, recordHash: 'f'.repeat(64) } },
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...ref('document_a'), purpose: 'financial_mandate' }], asset, account: pin('f'.repeat(64)), trust: null,
    governance: { budgetAccountId, generation: 1, accepted: ref('accepted_configuration_a') },
    startsAt, expiresAt: '2026-11-16T00:00:00.000Z' };
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, startsAt, endsAt), startsAt, endsAt },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true,
      actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50',
      maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...ref('approval_document'), purpose: 'approval_policy' }, { ...ref('budget_document'), purpose: 'budget_policy' }] };
  const base = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: null, id: 'policy_a',
    previous: null, organizationEpoch: 2, key: 'original_policy_001' };
  return [
    { ...base, kind: 'save_document', purpose: 'budget_policy', text: 'Budget terms.' },
    { ...base, kind: 'save_document', responsibilityId: 'responsibility_a', purpose: 'financial_mandate', text: 'Mandate terms.' },
    { ...base, kind: 'save_draft', responsibilityId: 'responsibility_a', draft },
    { ...base, kind: 'withdraw_draft', responsibilityId: 'responsibility_a', previous: ref() },
    { ...base, kind: 'propose_governance', bundle, expectedControl, expiresAt: '2026-11-16T00:00:00.000Z' },
    { ...base, kind: 'accept_governance', previous: ref(), expectedControl, nonce: 'A'.repeat(43),
      proposerEvidenceId: '00000000-0000-0000-0000-000000000001', mfaEvidenceId: '00000000-0000-0000-0000-000000000002' },
    { ...base, kind: 'reject_governance', previous: ref(), expectedControl, proposerEvidenceId: '00000000-0000-0000-0000-000000000001' },
  ] as FinancialPolicyCommand[];
}
const replace = (value: unknown, path: string[], replacement: unknown) => {
  const copy = structuredClone(value) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = replacement; return copy;
};
function leaves(value: unknown, prefix: string[] = []): [string[], unknown][] {
  if (value === null || typeof value !== 'object') return [[prefix, value]];
  return Object.entries(value).flatMap(([key, entry]) => leaves(entry, [...prefix, key]));
}
function changed(value: unknown): unknown {
  if (typeof value === 'number') return value === 300 ? 299 : value + 1;
  if (typeof value === 'boolean') return !value;
  if (value === null) return {};
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/.test(value)) return (value[0] === 'a' ? 'b' : 'a') + value.slice(1);
    if (/^[1-9][0-9]*$/.test(value)) return (BigInt(value) + 1n).toString();
    if (/\.000Z$/.test(value)) return value.replace('.000Z', '.001Z');
    return value + '_changed';
  }
  throw new Error('Unexpected fixture leaf.');
}

describe('financial policy public request digests and stored projection', () => {
  it('projects all six command kinds and both document scopes onto exact routes', async () => {
    const privateCommands = await commands();
    const routes = ['/v1/financial-governance/documents/policy_a', '/v1/responsibilities/responsibility_a/financial-policy-documents/policy_a',
      '/v1/responsibilities/responsibility_a/financial-policies/policy_a', '/v1/responsibilities/responsibility_a/financial-policies/policy_a/withdraw',
      '/v1/financial-governance/policy_a', '/v1/financial-governance/policy_a/accept', '/v1/financial-governance/policy_a/reject'];
    for (const [index, command] of privateCommands.entries()) {
      const before = canonical(command), request = await financialPolicyHttpRequestFromStoredCommand(scope(), command);
      expect(request.route).toBe(routes[index]);
      expect(request).toMatchObject({ kind: command.kind, responsibilityId: command.responsibilityId, id: command.id, key: command.key,
        input: { schemaVersion: 1, previous: command.previous, organizationEpoch: command.organizationEpoch } });
      expect(FinancialPolicyHttpRequestSchema.parse(request)).toEqual(request);
      expect(canonical(command)).toBe(before);
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.input)).toBe(true);
      expect(canonical(request)).not.toMatch(/"(?:environment|organizationId|actorId|subject|sessionId|proposerEvidenceId|mfaEvidenceId|nonce)":/);
    }
  });
  it('preserves every draft pin while moving duplicate environment/organization into server hash scope', async () => {
    const command = (await commands())[2] as Extract<FinancialPolicyCommand, { kind: 'save_draft' }>;
    const request = await financialPolicyHttpRequestFromStoredCommand(scope(), command);
    const { environment: _environment, organizationId: _organizationId, ...authority } = command.draft.scope.authority;
    expect(request.input).toEqual({ schemaVersion: 1, previous: null, organizationEpoch: 2,
      draft: { ...command.draft, scope: { ...command.draft.scope, authority } } });
    expect(Object.isFrozen((request as Extract<FinancialPolicyHttpRequest, { kind: 'save_draft' }>).input.draft.scope.authority.legacyHead)).toBe(true);
  });
  it('matches an independent canonical public preimage for every kind and differs from every private hash', async () => {
    expect(FINANCIAL_POLICY_HTTP_REQUEST_NAMESPACE).toBe('pactwoven:financial-policy-http-request:v1');
    for (const command of await commands()) {
      const request = await financialPolicyHttpRequestFromStoredCommand(scope(), command);
      const hash = await financialPolicyHttpRequestHash(scope(), request);
      expect(hash).toBe(await digest({ namespace: 'pactwoven:financial-policy-http-request:v1', environment: 'development',
        organizationId: 'org_a', actorId: 'owner_a', kind: request.kind, route: request.route, key: request.key, input: request.input }));
      expect(hash).not.toBe(await financialPolicyCommandHash('owner_a', command));
      expect(hash).not.toBe(await digest(request.input));
    }
  });
  it('keeps only private evidence/nonce changes outside the visible intent digest', async () => {
    const all = await commands();
    for (const command of all.filter(c => c.kind === 'accept_governance' || c.kind === 'reject_governance')) {
      const request = await financialPolicyHttpRequestFromStoredCommand(scope(), command), hash = await financialPolicyHttpRequestHash(scope(), request);
      const updates: Record<string, unknown>[] = [{ proposerEvidenceId: '00000000-0000-0000-0000-000000000009' }];
      if (command.kind === 'accept_governance') updates.push({ mfaEvidenceId: '00000000-0000-0000-0000-000000000008' }, { nonce: 'B'.repeat(42) + 'A' });
      for (const update of updates) {
        const altered = { ...command, ...update } as FinancialPolicyCommand;
        const projection = await financialPolicyHttpRequestFromStoredCommand(scope(), altered);
        expect(projection).toEqual(request); expect(await financialPolicyHttpRequestHash(scope(), projection)).toBe(hash);
        expect(await financialPolicyCommandHash('owner_a', altered)).not.toBe(await financialPolicyCommandHash('owner_a', command));
      }
    }
  });
  it('binds server environment, organization, actor, route target, key, purpose, text, predecessor and epoch', async () => {
    const request = await financialPolicyHttpRequestFromStoredCommand(scope(), (await commands())[0]);
    const hash = await financialPolicyHttpRequestHash(scope(), request);
    for (const changedScope of [{ ...scope(), environment: 'simulation' }, { ...scope(), organizationId: 'org_b' }, { ...scope(), actorId: 'owner_b' }])
      expect(await financialPolicyHttpRequestHash(changedScope, request)).not.toBe(hash);
    for (const update of [
      { ...request, id: 'policy_b', route: '/v1/financial-governance/documents/policy_b' },
      { ...request, key: 'original_policy_002' },
      { ...request, input: { ...request.input, purpose: 'approval_policy' } },
      { ...request, input: { ...request.input, text: 'Changed terms.' } },
      { ...request, input: { ...request.input, previous: ref() } },
      { ...request, input: { ...request.input, organizationEpoch: 3 } },
    ]) expect(await financialPolicyHttpRequestHash(scope(), update)).not.toBe(hash);
    const scopedDocument = await financialPolicyHttpRequestFromStoredCommand(scope(), (await commands())[1]);
    expect(await financialPolicyHttpRequestHash(scope(), { ...scopedDocument, responsibilityId: 'responsibility_b', route: '/v1/responsibilities/responsibility_b/financial-policy-documents/policy_a' }))
      .not.toBe(await financialPolicyHttpRequestHash(scope(), scopedDocument));
  });
  it('changes the digest for every accepted single-leaf material mutation and rejects inconsistent mutations', async () => {
    let accepted = 0, rejected = 0;
    for (const command of await commands()) {
      const request = await financialPolicyHttpRequestFromStoredCommand(scope(), command), baseline = await financialPolicyHttpRequestHash(scope(), request);
      for (const [path, value] of leaves(request.input)) {
        const candidate = replace(request, ['input', ...path], changed(value));
        const parsed = FinancialPolicyHttpRequestSchema.safeParse(candidate);
        if (!parsed.success) { rejected++; continue; }
        try { expect(await financialPolicyHttpRequestHash(scope(), candidate)).not.toBe(baseline); accepted++; }
        catch (error) { expect(error).toBeInstanceOf(DomainError); expect(error).toMatchObject({ code: 'FINANCIAL_POLICY_INVALID' }); rejected++; }
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(40); expect(rejected).toBeGreaterThanOrEqual(30);
  });
  it('requires exact authority and stable budget/period hashes after matching structural parsing', async () => {
    const all = await commands(), draft = await financialPolicyHttpRequestFromStoredCommand(scope(), all[2]), governance = await financialPolicyHttpRequestFromStoredCommand(scope(), all[4]);
    for (const request of [replace(draft, ['input', 'draft', 'scope', 'authorityHash'], 'a'.repeat(64)),
      replace(draft, ['input', 'draft', 'governance', 'budgetAccountId'], 'a'.repeat(64)),
      replace(governance, ['input', 'bundle', 'period', 'id'], 'a'.repeat(64))]) {
      expect(FinancialPolicyHttpRequestSchema.safeParse(request).success).toBe(true);
      await expect(financialPolicyHttpRequestHash(scope(), request)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INVALID', status: 422 });
    }
    await expect(financialPolicyHttpRequestHash({ ...scope(), organizationId: 'org_b' }, draft)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_INVALID' });
  });
  it('snapshots all mutable input before the first awaited digest', async () => {
    const original = await financialPolicyHttpRequestFromStoredCommand(scope(), (await commands())[4]);
    const mutable = structuredClone(original) as Extract<FinancialPolicyHttpRequest, { kind: 'propose_governance' }>, mutableScope = scope();
    const expected = await financialPolicyHttpRequestHash(scope(), original), pending = financialPolicyHttpRequestHash(mutableScope, mutable);
    mutable.input.bundle.limits.perOperation = '999'; mutable.key = 'replacement_key_001'; mutableScope.actorId = 'owner_b';
    expect(await pending).toBe(expected);
    const privateCommand = (await commands())[2] as Extract<FinancialPolicyCommand, { kind: 'save_draft' }>;
    const privateBefore = structuredClone(privateCommand), projection = financialPolicyHttpRequestFromStoredCommand(scope(), privateCommand);
    privateCommand.draft.scope.site.id = 'other_site'; privateCommand.key = 'replacement_key_002';
    expect(await projection).toEqual(await financialPolicyHttpRequestFromStoredCommand(scope(), privateBefore));
    const publicCopy = structuredClone(original), snapshot = snapshotFinancialPolicyHttpRequest(publicCopy);
    publicCopy.key = 'replacement_key_003'; expect(snapshot.key).toBe(original.key);
  });
  it('canonicalizes object property order without normalizing reviewed material', async () => {
    const request = await financialPolicyHttpRequestFromStoredCommand(scope(), (await commands())[0]);
    const reordered = { input: Object.fromEntries(Object.entries(request.input).reverse()), route: request.route, key: request.key,
      id: request.id, responsibilityId: request.responsibilityId, kind: request.kind };
    expect(await financialPolicyHttpRequestHash(scope(), reordered)).toBe(await financialPolicyHttpRequestHash(scope(), request));
    await expect(financialPolicyHttpRequestHash(scope(), { ...request, input: { ...request.input, text: 'Cafe\u0301' } })).rejects.toThrow();
  });
  it('refuses mismatched enclosing/nested scope and unsupported historical route IDs without alternate output', async () => {
    const all = await commands(), draft = all[2]!;
    for (const input of [
      { ...draft, organizationId: 'org_b' }, { ...draft, environment: 'simulation' },
      replace(draft, ['draft', 'scope', 'authority', 'organizationId'], 'org_b'),
      replace(draft, ['draft', 'scope', 'authority', 'environment'], 'simulation'),
      replace(draft, ['draft', 'scope', 'authority', 'responsibility', 'id'], 'responsibility_b'),
      replace(draft, ['draft', 'trust'], {}), { ...draft, id: 'context' },
      { ...all[4], id: 'documents' }, { ...all[0], unexpected: true },
      { ...all[5], proposerEvidenceId: 'not-an-evidence-uuid' },
    ]) await expect(financialPolicyHttpRequestFromStoredCommand(scope(), input)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', status: 503 });
  });
  it('does not erase a structurally valid private trust shape to create a public request', async () => {
    const command = (await commands())[2] as Extract<FinancialPolicyCommand, { kind: 'save_draft' }>;
    const qualification = (kind: string) => ({ kind, id: `${kind}_qualification`, version: 1, recordHash: 'a'.repeat(64), control: { key: 'b'.repeat(64), epoch: 0 } });
    const trust = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', asset: command.draft.asset, account: command.draft.account,
      assetQualification: qualification('asset'), custodyQualification: qualification('custody'), sources: [{ id: 'source_a', version: 1,
        recordHash: 'c'.repeat(64), financialUseEpoch: 0, binding: { accountKey: command.draft.account!.key, recordHash: 'd'.repeat(64), financialUseEpoch: 0 },
        qualification: qualification('source') }] };
    const historical = { ...command, draft: { ...command.draft, trust } };
    expect(FinancialPolicyCommandSchema.safeParse(historical).success).toBe(true);
    await expect(financialPolicyHttpRequestFromStoredCommand(scope(), historical)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
  });
  it('rejects public authority injection and malformed amounts with structured validation errors', async () => {
    const request = await financialPolicyHttpRequestFromStoredCommand(scope(), (await commands())[4]);
    for (const input of [{ ...request, actorId: 'owner_b' }, { ...request, input: { ...request.input, verified: true } },
      replace(request, ['input', 'bundle', 'limits', 'perOperation'], 'not-a-number')]) {
      try { await financialPolicyHttpRequestHash(scope(), input); throw new Error('Accepted malformed request.'); }
      catch (error) { expect(error).toMatchObject({ name: 'ZodError', issues: expect.any(Array) }); }
    }
    await expect(financialPolicyHttpRequestHash({ ...scope(), verified: true }, request)).rejects.toMatchObject({ name: 'ZodError' });
  });
  it('hashes the maximum valid multibyte document exactly', async () => {
    const command = (await commands())[0] as Extract<FinancialPolicyCommand, { kind: 'save_document' }>;
    command.text = '😀'.repeat(20_000);
    const request = await financialPolicyHttpRequestFromStoredCommand(scope(), command);
    expect((request.input as { text: string }).text).toBe(command.text);
    expect(await financialPolicyHttpRequestHash(scope(), request)).toMatch(/^[a-f0-9]{64}$/);
  });
});
