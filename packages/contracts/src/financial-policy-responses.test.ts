import { describe, expect, it } from 'vitest';
import { FINANCE_DEVNET_ASSET } from './finance-provenance';
import { FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES, FinancialPolicyHttpActorSchema, FinancialPolicyHttpScopeSchema,
  FinancialPolicyHttpObservationSchema, FinancialPolicyHttpRecordSchema, FinancialPolicyHttpPolicyViewSchema,
  FinancialPolicyHttpContextSchema, FinancialPolicyHttpRecordResponseSchema, FinancialPolicyHttpDraftIndexResponseSchema,
  FinancialPolicyHttpGovernanceIndexResponseSchema, FinancialPolicyHttpActionDecisionSchema, FinancialPolicyHttpReceiptSchema,
  FinancialPolicyHttpMutationResponseSchema, FinancialPolicyHttpRecoveryResponseSchema, FinancialPolicyHttpProposerObservationResponseSchema } from './financial-policy-responses';

const hash = 'a'.repeat(64), ref = (id: string, version = 1) => ({ id, version, recordHash: hash });
const owner = { actorId: 'owner_a', membershipVersion: 1 }, finance = { actorId: 'finance_a', membershipVersion: 1 };
const start = '2026-11-15T00:00:00.000Z', end = '2026-11-22T00:00:00.000Z', expires = '2026-11-16T00:00:00.000Z';
const scope = (operations = false) => ({ environment: 'development', organizationId: 'org_a', actor: owner, organizationEpoch: 2,
  roles: operations ? ['operations'] : ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] });
const envelope = (operations = false) => ({ schemaVersion: 1, scope: scope(operations), observation: { observedAt: start, expiresAt: '2026-11-15T00:00:20.000Z' }, effectiveAuthority: false, financialState: null });
const base = (id: string) => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a', id, version: 1, predecessor: null,
  actor: owner, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: start });
const document = (purpose = 'budget_policy', id = 'budget_doc') => ({ ...base(id), kind: 'document', responsibilityId: purpose === 'financial_mandate' ? 'responsibility_a' : null,
  purpose, text: 'Exact full terms.\nCafé 🧵', contentHash: hash });
const documentView = (purpose = 'budget_policy', id = 'budget_doc') => ({ record: document(purpose, id), reference: ref(id),
  projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null });
const pin = () => ({ key: 'b'.repeat(64), version: 1, recordHash: hash, financialUseEpoch: 0 });
const basis = () => ({ authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null },
  authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } });
const draft = () => ({ ...base('draft_a'), kind: 'draft', responsibilityId: 'responsibility_a', state: 'DRAFT', requester: owner,
  draft: { scope: basis(), terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
    supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...ref('mandate_doc'), purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null, startsAt: start, expiresAt: expires } });
const draftView = () => ({ record: draft(), reference: ref('draft_a'), projection: { currentRecord: true, state: 'DRAFT', blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] }, budgetConfiguration: null });
const zeroControl = () => ({ budgetAccountId: 'c'.repeat(64), generation: 0, accepted: null });
const bundle = () => ({ budgetAccountId: 'c'.repeat(64), asset: pin(), category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '18446744073709551615' },
  period: { id: 'd'.repeat(64), startsAt: start, endsAt: end }, approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'],
    independent: true, actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
  documents: [{ ...ref('approval_doc'), purpose: 'approval_policy' }, { ...ref('budget_doc'), purpose: 'budget_policy' }] });
const governance = (accepted = false) => ({ ...base('governance_a'), kind: 'governance', responsibilityId: null, state: accepted ? 'ACCEPTED' : 'OPEN',
  version: accepted ? 2 : 1, predecessor: accepted ? ref('governance_a') : null, actor: accepted ? finance : owner,
  proposer: owner, bundle: bundle(), expectedControl: zeroControl(), expiresAt: expires });
const control = () => ({ budgetAccountId: 'c'.repeat(64), generation: 1, accepted: ref('governance_a', 2) });
const governanceView = (accepted = false) => ({ record: governance(accepted), reference: ref('governance_a', accepted ? 2 : 1),
  projection: { currentRecord: true, state: accepted ? 'ACCEPTED' : 'OPEN', blockers: [] },
  budgetConfiguration: { status: 'observed', control: accepted ? control() : zeroControl(), currentBudgetConfiguration: accepted } });
const context = (operations = false, selected = false) => ({ ...envelope(operations), kind: operations ? 'responsibility' : 'organization',
  responsibilityId: operations ? 'responsibility_a' : null, configurationVisibility: operations ? 'references_only' : 'full', draftScope: operations ? basis() : null,
  asset: selected ? { ...FINANCE_DEVNET_ASSET, pin: pin(), decimals: 6, policy: 'solana-original-devnet-usdc-v1' } : null,
  control: selected ? control() : null, acceptedConfiguration: selected && !operations ? governanceView(true) : null,
  periods: selected && !operations ? [bundle().period] : [], documents: [], actions: [],
  blockers: selected ? ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] : ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] });
const receipt = () => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor: owner, responsibilityId: null,
  operationId: base('budget_doc').operationId, kind: 'save_document', key: 'original_document_key', publicRequestHash: 'e'.repeat(64), target: ref('budget_doc'),
  record: document(), effectiveAuthority: false, financialState: null });
const recovery = (recorded = true) => ({ ...envelope(), responsibilityId: null, kind: 'save_document', key: 'original_document_key', targetId: 'budget_doc',
  publicRequestHash: 'e'.repeat(64), status: recorded ? 'recorded' : 'not_recorded', receipt: recorded ? receipt() : null });
const replace = (input: unknown, path: string[], value: unknown) => {
  // A wire payload has no shared object references: mutate exactly one JSON path.
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>; let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = value; return copy;
};

describe('strict financial policy public responses', () => {
  it('accepts only local actor fields and bounded sorted current scope', () => {
    expect(FinancialPolicyHttpActorSchema.parse(owner)).toEqual(owner);
    for (const key of ['subject', 'sessionId', 'externalMembershipId', 'verified', 'identityEvidence'])
      expect(FinancialPolicyHttpActorSchema.safeParse({ ...owner, [key]: 'private' }).success).toBe(false);
    for (const value of [{ ...scope(), roles: ['owner', 'owner'] }, { ...scope(), roles: ['auditor'] }, { ...scope(), siteIds: ['site_b', 'site_a'] },
      { ...scope(), actionSiteIds: ['site_a', 'site_a'] }, { ...scope(), externalOrganizationId: 'private' }])
      expect(FinancialPolicyHttpScopeSchema.safeParse(value).success).toBe(false);
    for (const expiresAt of [start, '2026-11-15T00:00:20.001Z', '2026-02-30T00:00:01.000Z'])
      expect(FinancialPolicyHttpObservationSchema.safeParse({ observedAt: start, expiresAt }).success).toBe(false);
  });
  it('rejects private fields at every immutable record branch and keeps exact visible material', () => {
    for (const r of [document(), document('financial_mandate', 'mandate_doc'), draft(), governance(), governance(true)]) {
      expect(FinancialPolicyHttpRecordSchema.parse(r)).toEqual(r);
      for (const key of ['identityEvidence', 'decisionNonce', 'decision', 'commandHash', 'verified', 'currentRecord'])
        expect(FinancialPolicyHttpRecordSchema.safeParse({ ...r, [key]: 'private' }).success).toBe(false);
      expect(FinancialPolicyHttpRecordSchema.safeParse(replace(r, ['actor', 'sessionId'], 'private')).success).toBe(false);
    }
    expect(FinancialPolicyHttpRecordSchema.safeParse({ ...document(), responsibilityId: 'responsibility_a' }).success).toBe(false);
    expect(FinancialPolicyHttpRecordSchema.safeParse(replace(draft(), ['draft', 'scope', 'authority', 'environment'], 'development')).success).toBe(false);
    expect(FinancialPolicyHttpRecordSchema.safeParse(replace(draft(), ['draft', 'trust'], {})).success).toBe(false);
    expect(FinancialPolicyHttpRecordSchema.safeParse({ ...document(), version: 2 }).success).toBe(false);
  });
  it('requires an actual prior version for terminal states while retaining valid initial documents, drafts and proposals', () => {
    for (const value of [document(), document('financial_mandate', 'mandate_doc'), draft(), governance()])
      expect(FinancialPolicyHttpRecordSchema.safeParse(value).success).toBe(true);
    const terminal = [{ ...draft(), version: 2, predecessor: ref('draft_a'), state: 'WITHDRAWN' }, governance(true),
      { ...governance(true), state: 'REJECTED' }];
    for (const value of terminal) {
      expect(FinancialPolicyHttpRecordSchema.safeParse(value).success).toBe(true);
      expect(FinancialPolicyHttpRecordSchema.safeParse({ ...value, version: 1, predecessor: null }).success).toBe(false);
      expect(FinancialPolicyHttpRecordSchema.safeParse({ ...value, predecessor: null }).success).toBe(false);
    }
  });
  it('represents unavailable, historical accepted and expired current records without invented current-budget truth', () => {
    const old = governanceView(true);
    const historical = { ...old, budgetConfiguration: { status: 'observed', control: { ...control(), generation: 2, accepted: ref('later_governance', 2) }, currentBudgetConfiguration: false } };
    expect(FinancialPolicyHttpPolicyViewSchema.safeParse(historical).success).toBe(true);
    const unavailable = { ...governanceView(), budgetConfiguration: { status: 'unavailable', control: null, currentBudgetConfiguration: null } };
    expect(FinancialPolicyHttpPolicyViewSchema.safeParse(unavailable).success).toBe(true);
    expect(FinancialPolicyHttpPolicyViewSchema.safeParse(replace(unavailable, ['budgetConfiguration', 'currentBudgetConfiguration'], false)).success).toBe(false);
    expect(FinancialPolicyHttpPolicyViewSchema.safeParse({ ...governanceView(), projection: { currentRecord: true, state: 'EXPIRED', blockers: [] } }).success).toBe(true);
    for (const value of [replace(historical, ['budgetConfiguration', 'currentBudgetConfiguration'], true), replace(old, ['projection', 'currentRecord'], false),
      { ...governanceView(), budgetConfiguration: { status: 'observed', control: control(), currentBudgetConfiguration: false } },
      replace(documentView(), ['projection', 'state'], 'ACCEPTED'), replace(draftView(), ['projection', 'blockers'], [])])
      expect(FinancialPolicyHttpPolicyViewSchema.safeParse(value).success).toBe(false);
  });
  it('preserves opaque accepted references in Operations context without disclosing organization policy', () => {
    for (const selected of [false, true]) expect(FinancialPolicyHttpContextSchema.safeParse(context(true, selected)).success).toBe(true);
    const restricted = context(true, true);
    expect(restricted.blockers).not.toContain('GOVERNANCE_MISSING');
    for (const value of [{ ...restricted, configurationVisibility: 'full' }, { ...restricted, kind: 'organization', responsibilityId: null, draftScope: null },
      { ...restricted, acceptedConfiguration: governanceView(true) }, { ...restricted, periods: [bundle().period] }, { ...restricted, documents: [documentView()] },
      { ...restricted, blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] },
      replace(restricted, ['scope', 'actionSiteIds'], [])])
      expect(FinancialPolicyHttpContextSchema.safeParse(value).success).toBe(false);
    expect(FinancialPolicyHttpContextSchema.safeParse({ ...restricted, documents: [documentView('financial_mandate', 'mandate_doc')] }).success).toBe(true);
  });
  it('requires reciprocal full configuration, period, asset and scope when that context is disclosed', () => {
    const full = context(false, true); expect(FinancialPolicyHttpContextSchema.safeParse(full).success).toBe(true);
    for (const value of [{ ...full, acceptedConfiguration: null }, { ...full, periods: [] }, { ...full, periods: [bundle().period, bundle().period] },
      replace(full, ['control', 'accepted', 'recordHash'], 'f'.repeat(64)), replace(full, ['acceptedConfiguration', 'record', 'organizationId'], 'foreign'),
      replace(full, ['asset', 'mint'], FINANCE_DEVNET_ASSET.genesis), replace(full, ['asset', 'decimals'], 9), { ...full, effectiveAuthority: true },
      { ...full, financialState: 'funded' }, { ...full, documents: [documentView('financial_mandate', 'mandate_doc')] }])
      expect(FinancialPolicyHttpContextSchema.safeParse(value).success).toBe(false);
  });
  it('hydrates exact full document versions and rejects incomplete or substituted reviews', () => {
    const value = { ...envelope(), responsibilityId: null, policy: governanceView(), documents: [documentView('approval_policy', 'approval_doc'), documentView()], actions: [] };
    expect(FinancialPolicyHttpRecordResponseSchema.safeParse(value).success).toBe(true);
    for (const bad of [{ ...value, documents: [] }, { ...value, documents: [...value.documents].reverse() },
      replace(value, ['documents', '0', 'reference', 'recordHash'], 'f'.repeat(64)), replace(value, ['scope', 'roles'], ['operations']),
      replace(value, ['documents', '0', 'record', 'purpose'], 'budget_policy'), replace(value, ['scope', 'organizationId'], 'foreign')])
      expect(FinancialPolicyHttpRecordResponseSchema.safeParse(bad).success).toBe(false);
    const responsibility = { ...envelope(true), responsibilityId: 'responsibility_a', policy: draftView(), documents: [documentView('financial_mandate', 'mandate_doc')], actions: [] };
    expect(FinancialPolicyHttpRecordResponseSchema.safeParse(responsibility).success).toBe(true);
  });
  it('bounds and orders collections, keeping full document bodies out of indexes', () => {
    const index = { ...envelope(), kind: 'organization', responsibilityId: null, items: [{ policy: governanceView(), actions: [] }], nextId: null };
    expect(FinancialPolicyHttpGovernanceIndexResponseSchema.safeParse(index).success).toBe(true);
    for (const bad of [{ ...index, nextId: 'other' }, { ...index, items: [index.items[0], index.items[0]] },
      { ...index, items: Array.from({ length: 51 }, () => index.items[0]) }, { ...index, items: [{ policy: documentView(), actions: [] }] },
      replace(index, ['items', '0', 'policy', 'budgetConfiguration'], { status: 'unavailable', control: null, currentBudgetConfiguration: null }),
      { ...index, documents: [documentView()] }, replace(index, ['scope', 'roles'], ['operations'])])
      expect(FinancialPolicyHttpGovernanceIndexResponseSchema.safeParse(bad).success).toBe(false);
    const drafts = { ...envelope(true), kind: 'responsibility', responsibilityId: 'responsibility_a', items: [{ policy: draftView(), actions: [] }], nextId: 'draft_a' };
    expect(FinancialPolicyHttpDraftIndexResponseSchema.safeParse(drafts).success).toBe(true);
    expect(FinancialPolicyHttpDraftIndexResponseSchema.safeParse(replace(drafts, ['items', '0', 'policy', 'projection'], { currentRecord: false, state: 'SUPERSEDED', blockers: draftView().projection.blockers })).success).toBe(false);
  });
  it('separates action reviewability from factor requirements and configuration authority blockers', () => {
    const save = { action: 'save_draft', state: 'reviewable', reasons: [], requiredAuthentication: null };
    expect(FinancialPolicyHttpActionDecisionSchema.safeParse(save).success).toBe(true);
    expect(FinancialPolicyHttpContextSchema.safeParse({ ...context(true), actions: [save] }).success).toBe(true);
    for (const action of ['reject_governance', 'withdraw_draft']) {
      expect(FinancialPolicyHttpActionDecisionSchema.safeParse({ ...save, action }).success).toBe(true);
      expect(FinancialPolicyHttpActionDecisionSchema.safeParse({ ...save, action, requiredAuthentication: 'financial_policy_authorization' }).success).toBe(false);
    }
    expect(FinancialPolicyHttpActionDecisionSchema.safeParse({ action: 'accept_governance', state: 'not_evaluated', reasons: ['ELIGIBILITY_NOT_EVALUATED'], requiredAuthentication: 'financial_policy_authorization' }).success).toBe(true);
    for (const value of [{ ...save, action: 'accept_governance' }, { ...save, state: 'blocked' }, { ...save, reasons: ['SITE_ACCESS_REQUIRED'] },
      { ...save, action: 'allocate_funds' }, { ...save, state: 'not_evaluated' }, { ...save, verified: true }])
      expect(FinancialPolicyHttpActionDecisionSchema.safeParse(value).success).toBe(false);
  });
  it('keeps historical receipts separate from current memberships and current-state claims', () => {
    const r = receipt(), response = { ...envelope(), scope: { ...scope(), actor: { ...owner, membershipVersion: 9 } }, status: 'recorded', receipt: r };
    expect(FinancialPolicyHttpReceiptSchema.safeParse(r).success).toBe(true);
    expect(FinancialPolicyHttpMutationResponseSchema.safeParse(response).success).toBe(true);
    for (const value of [{ ...r, currentRecord: true }, { ...r, currentBudgetConfiguration: true }, { ...r, commandHash: hash },
      { ...r, kind: 'accept_governance' }, replace(r, ['target', 'id'], 'other'), replace(r, ['record', 'actor', 'actorId'], 'other')])
      expect(FinancialPolicyHttpReceiptSchema.safeParse(value).success).toBe(false);
    expect(FinancialPolicyHttpMutationResponseSchema.safeParse(replace(response, ['scope', 'roles'], ['operations'])).success).toBe(false);
  });
  it('allows only exact recorded-or-null recovery envelopes and does not encode failure as absence', () => {
    expect(FinancialPolicyHttpRecoveryResponseSchema.safeParse(recovery()).success).toBe(true);
    expect(FinancialPolicyHttpRecoveryResponseSchema.safeParse(recovery(false)).success).toBe(true);
    for (const value of [{ ...recovery(), receipt: null }, { ...recovery(false), receipt: receipt() }, { ...recovery(), status: 'failed' },
      { ...recovery(), publicRequestHash: 'f'.repeat(64) }, { ...recovery(), key: 'different_original_key' },
      { ...recovery(), targetId: 'other' }, { ...recovery(), command: {} }, replace(recovery(), ['scope', 'actor', 'actorId'], 'other')])
      expect(FinancialPolicyHttpRecoveryResponseSchema.safeParse(value).success).toBe(false);
  });
  it('exposes proposer availability with a bounded deadline and no private observation reference', () => {
    const value = { ...envelope(), proposal: ref('governance_a'), control: zeroControl(), status: 'available', expiresAt: '2026-11-15T00:00:10.000Z' };
    expect(FinancialPolicyHttpProposerObservationResponseSchema.safeParse(value).success).toBe(true);
    expect(FinancialPolicyHttpProposerObservationResponseSchema.safeParse({ ...value, status: 'unavailable', expiresAt: null }).success).toBe(true);
    for (const bad of [{ ...value, observationId: 'private' }, { ...value, status: 'unavailable' }, { ...value, expiresAt: '2026-11-15T00:00:20.001Z' },
      { ...value, expiresAt: start }, replace(value, ['scope', 'roles'], ['operations'])])
      expect(FinancialPolicyHttpProposerObservationResponseSchema.safeParse(bad).success).toBe(false);
  });
  it('fits complete maximum Unicode documents and a full bounded governance page without truncation', () => {
    const text = '🧵'.repeat(20_000), full = context();
    const documents = Array.from({ length: 8 }, (_, i) => { const d = documentView('budget_policy', `document_${i}`); return { ...d, record: { ...d.record, text } }; });
    const value = { ...full, documents };
    expect(FinancialPolicyHttpContextSchema.safeParse(value).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES);
    const items = Array.from({ length: 50 }, (_, i) => {
      const id = `governance_${String(i).padStart(3, '0')}`, p = governanceView();
      const sites = Array.from({ length: 100 }, (_, n) => `site_${String(n).padStart(3, '0')}_${'s'.repeat(119)}`);
      return { policy: { ...p, reference: ref(id), record: { ...p.record, id, bundle: { ...p.record.bundle, approval: { ...p.record.bundle.approval, actionSiteIds: sites } } } }, actions: [] };
    });
    const page = { ...envelope(), kind: 'organization', responsibilityId: null, items, nextId: items.at(-1)!.policy.record.id };
    expect(FinancialPolicyHttpGovernanceIndexResponseSchema.safeParse(page).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES);
    expect(FinancialPolicyHttpContextSchema.safeParse({ ...value, documents: documents.map(d => ({ ...d, record: { ...d.record, text: text + 'a' } })) }).success).toBe(false);
  });
});
