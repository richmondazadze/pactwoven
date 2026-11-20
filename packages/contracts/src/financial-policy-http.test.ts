import { describe, expect, it } from 'vitest';
import { FinancialPolicyHttpRequestSchema, FinancialPolicyHttpDraftSchema, FinancialPolicyHttpRouteIdentitySchema,
  FinancialPolicyResponsibilityDocumentHttpSchema, FinancialPolicyGovernanceDocumentHttpSchema,
  financialPolicyHttpRoute, type FinancialPolicyHttpRequest } from './financial-policy-http';

const ref = (id = 'policy_a') => ({ id, version: 1, recordHash: 'a'.repeat(64) });
const control = () => ({ budgetAccountId: 'b'.repeat(64), generation: 0, accepted: null });
const pin = () => ({ key: 'c'.repeat(64), version: 1, recordHash: 'd'.repeat(64), financialUseEpoch: 0 });
const common = () => ({ schemaVersion: 1, previous: null, organizationEpoch: 2 });
const draft = () => ({
  scope: { authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash: 'e'.repeat(64), siteId: 'site_a' },
    generation: 0, family: 'none', legacyHead: null }, authorityHash: 'f'.repeat(64), site: { id: 'site_a', generation: 0, recordHash: 'a'.repeat(64) } },
  terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
    supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
    communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
  documents: [{ ...ref('document_a'), purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null,
  startsAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-11-16T00:00:00.000Z',
});
const bundle = () => ({ budgetAccountId: 'b'.repeat(64), asset: pin(), category: 'supplier_principal',
  limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
  period: { id: 'e'.repeat(64), startsAt: '2026-11-15T00:00:00.000Z', endsAt: '2026-11-22T00:00:00.000Z' },
  approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true,
    actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50',
    maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
  documents: [{ ...ref('approval_document'), purpose: 'approval_policy' }, { ...ref('budget_document'), purpose: 'budget_policy' }],
});
const examples = (): FinancialPolicyHttpRequest[] => [
  { kind: 'save_document', responsibilityId: 'responsibility_a', id: 'policy_a', key: 'original_policy_001', route: '/v1/responsibilities/responsibility_a/financial-policy-documents/policy_a', input: { ...common(), purpose: 'financial_mandate', text: 'Exact full terms.' } },
  { kind: 'save_document', responsibilityId: null, id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/documents/policy_a', input: { ...common(), purpose: 'budget_policy', text: 'Exact full terms.' } },
  { kind: 'save_draft', responsibilityId: 'responsibility_a', id: 'policy_a', key: 'original_policy_001', route: '/v1/responsibilities/responsibility_a/financial-policies/policy_a', input: { ...common(), draft: draft() } },
  { kind: 'withdraw_draft', responsibilityId: 'responsibility_a', id: 'policy_a', key: 'original_policy_001', route: '/v1/responsibilities/responsibility_a/financial-policies/policy_a/withdraw', input: { ...common(), previous: ref() } },
  { kind: 'propose_governance', responsibilityId: null, id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/policy_a', input: { ...common(), bundle: bundle(), expectedControl: control(), expiresAt: '2026-11-16T00:00:00.000Z' } },
  { kind: 'accept_governance', responsibilityId: null, id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/policy_a/accept', input: { ...common(), previous: ref(), expectedControl: control() } },
  { kind: 'reject_governance', responsibilityId: null, id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/policy_a/reject', input: { ...common(), previous: ref(), expectedControl: control() } },
] as FinancialPolicyHttpRequest[];
const replace = (value: unknown, path: string[], replacement: unknown) => {
  const copy = structuredClone(value) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = replacement; return copy;
};

describe('financial policy public request contracts', () => {
  it.each(examples().map((request, index) => ({ index, request })))('maps exact route and input for request $index / $request.kind', ({ request }) => {
    expect(FinancialPolicyHttpRequestSchema.parse(request)).toEqual(request);
    expect(financialPolicyHttpRoute({ kind: request.kind, responsibilityId: request.responsibilityId, id: request.id })).toBe(request.route);
  });
  it('excludes all caller authority and private evidence fields at both snapshot and body boundaries', () => {
    const keys = ['environment', 'organizationId', 'actorId', 'subject', 'sessionId', 'externalMembershipId', 'membershipVersion',
      'identityEvidenceId', 'proposerEvidenceId', 'mfaEvidenceId', 'nonce', 'verified', 'qualified', 'effectiveAuthority', 'financialState'];
    for (const request of examples()) for (const key of keys) {
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, [key]: 'forbidden' }).success).toBe(false);
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, [key]: 'forbidden' } }).success).toBe(false);
    }
    const request = examples()[2]!;
    for (const key of ['environment', 'organizationId', 'actorId', 'sessionId', 'verified']) {
      const authority = (request as Extract<FinancialPolicyHttpRequest, { kind: 'save_draft' }>).input.draft.scope.authority;
      expect(FinancialPolicyHttpRequestSchema.safeParse(replace(request, ['input', 'draft', 'scope', 'authority'], { ...authority, [key]: 'forbidden' })).success).toBe(false);
    }
  });
  it('never aliases encoded, absolute, query-bearing, trailing-slash or different target routes', () => {
    for (const request of examples()) for (const route of [request.route + '/', request.route + '?kind=x', request.route + '#x',
      request.route.replace('policy_a', 'policy_b'), request.route.replace('policy_a', 'policy%5Fa'), request.route.replace('/v1/', '//v1/'),
      'https://example.invalid' + request.route, request.route.replace('/v1/', '/V1/')])
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, route }).success).toBe(false);
    for (const id of ['', 'a/b', 'a%2Fb', 'a?b', 'a.b', 'a b', 'é', 'a'.repeat(129)])
      expect(FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: 'propose_governance', responsibilityId: null, id }).success).toBe(false);
  });
  it('reserves literal governance IDs and the responsibility context ID without changing document IDs', () => {
    for (const kind of ['propose_governance', 'accept_governance', 'reject_governance']) for (const id of ['context', 'documents', 'operations'])
      expect(FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind, responsibilityId: null, id }).success).toBe(false);
    for (const kind of ['save_draft', 'withdraw_draft'])
      expect(FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind, responsibilityId: 'responsibility_a', id: 'context' }).success).toBe(false);
    for (const responsibilityId of [null, 'responsibility_a']) for (const id of ['context', 'documents', 'operations'])
      expect(FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: 'save_document', responsibilityId, id }).success).toBe(true);
  });
  it('requires exact scope, predecessor target, key and epoch', () => {
    for (const request of examples()) {
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, previous: ref('other_policy') } }).success).toBe(false);
      for (const key of ['', 'too_short', 'original/key_is_wrong', 'x'.repeat(129)]) expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, key }).success).toBe(false);
      for (const organizationEpoch of [-1, 1.1, 2147483648, '2']) expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, organizationEpoch } }).success).toBe(false);
      if (request.kind !== 'save_document') expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, responsibilityId: request.responsibilityId === null ? 'responsibility_a' : null }).success).toBe(false);
    }
    for (const request of examples().filter(r => ['withdraw_draft', 'accept_governance', 'reject_governance'].includes(r.kind)))
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, previous: null } }).success).toBe(false);
  });
  it('separates financial-mandate documents from both organization policy purposes', () => {
    for (const purpose of ['financial_mandate', 'budget_policy', 'approval_policy']) {
      expect(FinancialPolicyResponsibilityDocumentHttpSchema.safeParse({ ...common(), purpose, text: 'Terms.' }).success).toBe(purpose === 'financial_mandate');
      expect(FinancialPolicyGovernanceDocumentHttpSchema.safeParse({ ...common(), purpose, text: 'Terms.' }).success).toBe(purpose !== 'financial_mandate');
      for (const request of examples().filter(r => r.kind === 'save_document')) expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, purpose } }).success)
        .toBe((request.responsibilityId !== null) === (purpose === 'financial_mandate'));
    }
  });
  it('preserves maximum normalized Unicode text and rejects malformed text before transport', () => {
    for (const text of ['😀'.repeat(20_000), 'A'.repeat(20_000), 'Café\nExact terms.'])
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...examples()[0], input: { ...common(), purpose: 'financial_mandate', text } }).success).toBe(true);
    for (const text of ['😀'.repeat(20_001), 'Cafe\u0301', '\ud800', 'terms\r\nnext', 'a\0b', ' \n '])
      expect(FinancialPolicyHttpRequestSchema.safeParse({ ...examples()[0], input: { ...common(), purpose: 'financial_mandate', text } }).success).toBe(false);
  });
  it('requires explicit null trust, matching route/site/family and the only supported draft terms', () => {
    const request = examples()[2]!;
    const cases: [string[], unknown][] = [
      [['trust'], {}], [['scope', 'site', 'id'], 'site_b'], [['scope', 'authority', 'family'], 'financial'],
      [['scope', 'authority', 'family'], 'legacy'], [['terms', 'mode'], 'AUTONOMOUS'], [['terms', 'payee'], {}],
      [['terms', 'communication', 'allowanceBaseUnits'], '1'], [['documents'], [{ ...ref('document_a'), purpose: 'budget_policy' }]],
      [['account'], pin()], [['governance'], control()],
    ];
    for (const [path, value] of cases) expect(FinancialPolicyHttpDraftSchema.safeParse(replace(draft(), path, value)).success).toBe(false);
    expect(FinancialPolicyHttpRequestSchema.safeParse(replace(request, ['input', 'draft', 'scope', 'authority', 'responsibility', 'id'], 'responsibility_b')).success).toBe(false);
  });
  it('returns structured errors for malformed amounts through the complete public request', () => {
    for (const field of ['perOperation', 'perResponsibility', 'perPeriod', 'thresholdBaseUnits']) for (const amount of ['not-a-number', '1e3', '1.1', '', '0', '01', '-1', '+1', ' 2', '2 ', '0x10', '18446744073709551616', null, 100]) {
      const path = ['input', 'bundle', field === 'thresholdBaseUnits' ? 'approval' : 'limits', field];
      const parsed = FinancialPolicyHttpRequestSchema.safeParse(replace(examples()[4], path, amount));
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    }
    const request = examples()[4] as Extract<FinancialPolicyHttpRequest, { kind: 'propose_governance' }>;
    const amount = '18446744073709551615';
    expect(FinancialPolicyHttpRequestSchema.safeParse({ ...request, input: { ...request.input, bundle: { ...request.input.bundle,
      limits: { perOperation: amount, perResponsibility: amount, perPeriod: amount }, approval: { ...request.input.bundle.approval, thresholdBaseUnits: amount } } } }).success).toBe(true);
  });
  it('rejects mismatched budget controls, interval bounds and unknown nested fields', () => {
    for (const [path, value] of [
      [['input', 'expectedControl', 'budgetAccountId'], 'c'.repeat(64)], [['input', 'bundle', 'period', 'endsAt'], '2026-11-15T00:00:00.000Z'],
      [['input', 'bundle', 'approval', 'independent'], false], [['input', 'bundle', 'limits', 'perOperation'], '501'],
      [['input', 'bundle', 'approval', 'thresholdBaseUnits'], '101'], [['input', 'bundle', 'asset', 'verified'], true],
    ] as [string[], unknown][]) expect(FinancialPolicyHttpRequestSchema.safeParse(replace(examples()[4], path, value)).success).toBe(false);
  });
});
