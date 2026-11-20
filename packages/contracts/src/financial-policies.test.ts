import { describe, expect, it } from 'vitest';
import { FinancialPolicyTextSchema, FinancialPolicyInstantSchema, FinancialPolicyAmountSchema, FinancialBudgetLimitsSchema,
  FinancialApprovalPolicySchema, FinancialGovernanceControlRefSchema, FinancialDraftTermsSchema, FinancialPolicyCommandSchema,
  FinancialPolicyRecordSchema, FinancialGovernanceBundleSchema, type FinancialPolicyCommand } from './financial-policies';

const governanceCommand = (): Extract<FinancialPolicyCommand, { kind: 'propose_governance' }> => ({
  schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: null, id: 'configuration_a',
  key: 'original_governance_001', previous: null, organizationEpoch: 2, kind: 'propose_governance',
  expectedControl: { budgetAccountId: 'b'.repeat(64), generation: 0, accepted: null }, expiresAt: '2026-11-16T12:00:00.000Z',
  bundle: { budgetAccountId: 'b'.repeat(64), asset: { key: 'a'.repeat(64), version: 1, recordHash: 'c'.repeat(64), financialUseEpoch: 0 },
    category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: 'd'.repeat(64), startsAt: '2026-11-15T00:00:00.000Z', endsAt: '2026-11-22T00:00:00.000Z' },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'],
      action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '100', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ id: 'approval_document', version: 1, recordHash: 'e'.repeat(64), purpose: 'approval_policy' },
      { id: 'budget_document', version: 1, recordHash: 'f'.repeat(64), purpose: 'budget_policy' }] },
});

describe('financial policy draft-only contracts', () => {
  it.each(['0', '01', '-1', '+1', '1.0', '1e2', '18446744073709551616', ' 2'])('rejects noncanonical or unsupported positive limit %s', value => expect(FinancialPolicyAmountSchema.safeParse(value).success).toBe(false));
  it('supports exact u64 limits and bounds operation <= responsibility <= period', () => {
    expect(FinancialPolicyAmountSchema.parse('18446744073709551615')).toBe('18446744073709551615');
    expect(FinancialBudgetLimitsSchema.safeParse({ perOperation: '10', perResponsibility: '9', perPeriod: '100' }).success).toBe(false);
    expect(FinancialBudgetLimitsSchema.safeParse({ perOperation: '10', perResponsibility: '99', perPeriod: '98' }).success).toBe(false);
  });
  it.each(['perOperation', 'perResponsibility', 'perPeriod', 'thresholdBaseUnits'] as const)('returns structured field errors for malformed %s through the governance command', field => {
    for (const value of ['not-a-number', '1e3', '1.1', '', '0', '01', '-1', '+1', ' 2', '2 ', '0x10', '18446744073709551616', null, 100]) {
      const command = governanceCommand();
      const bundle = { ...command.bundle, ...(field === 'thresholdBaseUnits'
        ? { approval: { ...command.bundle.approval, thresholdBaseUnits: value } }
        : { limits: { ...command.bundle.limits, [field]: value } }) };
      const path = [field === 'thresholdBaseUnits' ? 'approval' : 'limits', field];
      const checks = [
        [field === 'thresholdBaseUnits' ? FinancialApprovalPolicySchema.safeParse(bundle.approval) : FinancialBudgetLimitsSchema.safeParse(bundle.limits), [field]],
        [FinancialGovernanceBundleSchema.safeParse(bundle), path],
        [FinancialPolicyCommandSchema.safeParse({ ...command, bundle }), ['bundle', ...path]],
      ] as const;
      for (const [result, issuePath] of checks) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: issuePath })]));
      }
    }
  });
  it.each(['1', '100', '18446744073709551615'])('accepts exact equal limits and threshold at %s through the governance command', value => {
    const command = governanceCommand();
    command.bundle.limits = { perOperation: value, perResponsibility: value, perPeriod: value };
    command.bundle.approval.thresholdBaseUnits = value;
    expect(FinancialGovernanceBundleSchema.parse(command.bundle)).toEqual(command.bundle);
    expect(FinancialPolicyCommandSchema.parse(command)).toEqual(command);
  });
  it('still enforces limit order, threshold and exact document purposes at the governance boundary', () => {
    const command = governanceCommand();
    expect(FinancialPolicyCommandSchema.parse(command)).toEqual(command);
    for (const bundle of [
      { ...command.bundle, limits: { ...command.bundle.limits, perOperation: '501' } },
      { ...command.bundle, limits: { ...command.bundle.limits, perResponsibility: '1001' } },
      { ...command.bundle, approval: { ...command.bundle.approval, thresholdBaseUnits: '101' } },
      { ...command.bundle, documents: command.bundle.documents.map(document => ({ ...document, purpose: 'budget_policy' })) },
    ]) expect(FinancialPolicyCommandSchema.safeParse({ ...command, bundle }).success).toBe(false);
  });
  it.each(['0000-01-01T00:00:00.000Z','2026-11-15T24:00:00.000Z','2026-02-30T12:00:00.000Z','2026-11-15T12:00:00Z','2026-11-15T12:00:00.000+00:00'])('rejects noncanonical instant %s', value => expect(FinancialPolicyInstantSchema.safeParse(value).success).toBe(false));
  it('requires normalized full text without control characters or lone surrogates', () => {
    expect(FinancialPolicyTextSchema.parse('Café\nExact terms.')).toBe('Café\nExact terms.');
    for (const text of ['Cafe\u0301', ' \n ', 'terms\r\nnext', 'terms\0', 'terms\ud800', 'a'.repeat(20001)]) expect(FinancialPolicyTextSchema.safeParse(text).success).toBe(false);
    expect(FinancialPolicyTextSchema.safeParse('😀'.repeat(20000)).success).toBe(true);
  });
  it('requires the initial or an exact nonzero governance control, never a detached accepted pointer', () => {
    const ref = { id: 'configuration_a', version: 1, recordHash: 'a'.repeat(64) }, base = { budgetAccountId: 'b'.repeat(64) };
    expect(FinancialGovernanceControlRefSchema.safeParse({ ...base, generation: 0, accepted: null }).success).toBe(true);
    for (const value of [{ ...base, generation: 0, accepted: ref }, { ...base, generation: 1, accepted: null }, { ...base, generation: 2147483648, accepted: ref }]) expect(FinancialGovernanceControlRefSchema.safeParse(value).success).toBe(false);
  });
  it('does not permit additional action families or implicit communication spending', () => {
    const terms = { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } };
    expect(FinancialDraftTermsSchema.safeParse(terms).success).toBe(true);
    for (const patch of [{ mode: 'AUTONOMOUS' }, { actions: ['allocate_funds','pay_supplier'] }, { category: 'platform_fee' }, { withdrawal: 'owner_wallet' },
      { communication: { ...terms.communication, recipients: ['supplier_a'] } }]) expect(FinancialDraftTermsSchema.safeParse({ ...terms, ...patch }).success).toBe(false);
  });
  it('requires independent sorted role/site policy and bounded authentication age', () => {
    const policy = { requesterRoles: ['finance','operations','owner'], approverRoles: ['finance','owner'], independent: true, actionSiteIds: ['site_a'],
      action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '1', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 };
    expect(FinancialApprovalPolicySchema.safeParse(policy).success).toBe(true);
    for (const patch of [{ independent: false }, { approverRoles: ['operations'] }, { requesterRoles: ['owner','finance'] }, { actionSiteIds: ['site_a','site_a'] },
      { maximumAuthenticationAgeSeconds: 301 }]) expect(FinancialApprovalPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
  });
  it('rejects authority promotion and public verified flags at the command boundary', () => {
    const command = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a',
      id: 'document_a', key: 'original_policy_001', previous: null, organizationEpoch: 2, kind: 'save_document', purpose: 'financial_mandate', text: 'Exact terms.' };
    expect(FinancialPolicyCommandSchema.safeParse(command).success).toBe(true);
    for (const value of [{ ...command, kind: 'promote' }, { ...command, verified: true }, { ...command, effectiveAuthority: true }]) expect(FinancialPolicyCommandSchema.safeParse(value).success).toBe(false);
    expect(FinancialPolicyRecordSchema.safeParse({ ...command, kind: 'financial_head' }).success).toBe(false);
  });
});
