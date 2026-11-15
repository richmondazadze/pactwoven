import { describe, expect, it } from 'vitest';
import { FINANCE_DEVNET_ASSET } from './finance-provenance';
import { FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationResponseSchema, FinancialPolicyPreparationDecisionSchema,
  FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES, FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES } from './financial-policy-preparation';

const hash = 'a'.repeat(64), accountId = 'b'.repeat(64), assetKey = 'c'.repeat(64);
const ref = (id: string, version = 1) => ({ id, version, recordHash: hash });
const warnings = ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'];
const actor = { actorId: 'actor_a', membershipVersion: 1 };
const scope = () => ({ environment: 'development', organizationId: 'org_a', actor: { ...actor, membershipVersion: 9 },
  organizationEpoch: 4, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] });
const basis = () => ({ authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' },
  generation: 0, family: 'none', legacyHead: null }, authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } });
const pin = () => ({ key: assetKey, version: 1, recordHash: hash, financialUseEpoch: 0 });
const control = () => ({ budgetAccountId: accountId, generation: 0, accepted: null });
const period = (index = 0) => ({ id: index.toString(16).padStart(64, '0'), startsAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), endsAt: new Date(Date.UTC(2026, 0, index + 2)).toISOString() });
const commonRecord = (id: string, rid: string | null, version = 1) => ({ schemaVersion: 1, environment: 'development', organizationId: 'org_a',
  responsibilityId: rid, id, version, predecessor: version === 1 ? null : ref(id, version - 1), actor, organizationEpoch: 2,
  operationId: '00000000-0000-0000-0000-000000000001', createdAt: '2025-01-01T00:00:00.000Z' });
function document(id: string, purpose = 'financial_mandate', current = true, version = 1) {
  return { reference: ref(id, version), record: { ...commonRecord(id, purpose === 'financial_mandate' ? 'responsibility_a' : null, version),
    kind: 'document', purpose, text: 'Exact complete terms. Café 🧵', contentHash: hash },
    projection: { currentRecord: current, state: current ? 'DOCUMENT' : 'SUPERSEDED', blockers: [] }, budgetConfiguration: null };
}
const draft = () => ({ scope: basis(), terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
  supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
  documents: [{ ...ref('mandate_doc'), purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null,
  startsAt: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' });
const bundle = () => ({ budgetAccountId: accountId, asset: pin(), category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
  period: period(), approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true,
    actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '100', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
  documents: [{ ...ref('approval_doc'), purpose: 'approval_policy' }, { ...ref('budget_doc'), purpose: 'budget_policy' }] });
const decision = (action: string, reasons: string[] = []) => ({ action, state: reasons.length ? 'blocked' : 'reviewable', reasons: [...reasons].sort(), requiredAuthentication: null });
const absent = () => ({ state: 'absent', latestReference: null, record: null, historicalDocuments: [] });
const unavailable = () => ({ state: 'unavailable', latestReference: null, record: null, historicalDocuments: [] });
function examples() {
  const base = { schemaVersion: 1, scope: scope(), observation: { observedAt: '2026-11-15T12:00:00.000Z', expiresAt: '2026-11-15T12:00:20.000Z' },
    configurationWarnings: warnings, effectiveAuthority: false, financialState: null };
  const requestBase = { schemaVersion: 1, targetId: 'target_a', previous: null };
  const documentResponse = { ...base, responsibilityId: 'responsibility_a', selection: { ...requestBase, action: 'save_document', purpose: 'financial_mandate' },
    decision: decision('save_document'), target: absent(), material: { action: 'save_document', purpose: 'financial_mandate', organizationEpoch: 4, draftScope: basis(), siteActive: true } };
  const draftResponse = { ...base, responsibilityId: 'responsibility_a', selection: { ...requestBase, action: 'save_draft', document: ref('mandate_doc') },
    decision: decision('save_draft'), target: absent(), material: { action: 'save_draft', profile: 'incomplete', draftScope: basis(), siteActive: true,
      document: document('mandate_doc'), asset: null, account: null, governance: null, trust: null } };
  const oldDraft = { reference: ref('target_a'), record: { ...commonRecord('target_a', 'responsibility_a'), kind: 'draft', state: 'DRAFT', requester: actor, draft: draft() },
    projection: { currentRecord: true, state: 'EXPIRED', blockers: ['DRAFT_EXPIRED', ...warnings] }, budgetConfiguration: null };
  const withdrawal = { ...base, responsibilityId: 'responsibility_a', selection: { ...requestBase, action: 'withdraw_draft', previous: ref('target_a') },
    decision: decision('withdraw_draft'), target: { state: 'exact', latestReference: ref('target_a'), record: oldDraft, historicalDocuments: [document('mandate_doc', 'financial_mandate', false)] },
    material: { action: 'withdraw_draft' } };
  const governance = { ...base, responsibilityId: null, selection: { ...requestBase, action: 'propose_governance', assetKey, budgetDocument: ref('budget_doc'), approvalDocument: ref('approval_doc') },
    decision: decision('propose_governance'), target: absent(), material: { action: 'propose_governance', asset: { ...FINANCE_DEVNET_ASSET, pin: pin(), decimals: 6, policy: 'solana-original-devnet-usdc-v1' },
      budgetAccountId: accountId, control: control(), acceptedConfiguration: null, periods: [period()], budgetDocument: document('budget_doc', 'budget_policy'),
      approvalDocument: document('approval_doc', 'approval_policy'), eligibleActionSites: [{ id: 'site_a', generation: 2, recordHash: hash }] } };
  return { document: documentResponse, draft: draftResponse, withdrawal, governance };
}
function replace(value: unknown, path: (string | number)[], replacement: unknown): any {
  const copy = structuredClone(value) as any; let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path.at(-1)!] = replacement; return copy;
}
const parses = (value: unknown) => FinancialPolicyPreparationResponseSchema.safeParse(value).success;
function revision(kind: 'document' | 'draft' | 'governance'): any {
  const all = examples(), value: any = structuredClone(all[kind]); value.selection.previous = ref('target_a');
  if (kind === 'document') value.target = { state: 'exact', latestReference: ref('target_a'), record: document('target_a'), historicalDocuments: [] };
  if (kind === 'draft') value.target = structuredClone(all.withdrawal.target);
  if (kind === 'governance') value.target = { state: 'exact', latestReference: ref('target_a'), historicalDocuments: [document('approval_doc', 'approval_policy'), document('budget_doc', 'budget_policy')],
    record: { reference: ref('target_a'), record: { ...commonRecord('target_a', null), kind: 'governance', state: 'OPEN', proposer: actor, bundle: bundle(), expectedControl: control(), expiresAt: '2025-01-02T00:00:00.000Z' },
      projection: { currentRecord: true, state: 'EXPIRED', blockers: [] }, budgetConfiguration: { status: 'observed', control: control(), currentBudgetConfiguration: false } } };
  return value;
}
function acceptedContext(value: any) {
  const accepted = revision('governance').target.record;
  accepted.reference = ref('accepted_a', 2); Object.assign(accepted.record, commonRecord('accepted_a', null, 2),
    { state: 'ACCEPTED', actor: { actorId: 'reviewer_b', membershipVersion: 2 } });
  accepted.projection = { currentRecord: true, state: 'ACCEPTED', blockers: [] };
  const current = { budgetAccountId: accountId, generation: 1, accepted: ref('accepted_a', 2) };
  accepted.budgetConfiguration = { status: 'observed', control: current, currentBudgetConfiguration: true };
  value.material.control = current; value.material.acceptedConfiguration = accepted;
  return current;
}

describe('financial policy metadata-only preparation requests', () => {
  it.each(Object.entries(examples()))('accepts the exact %s selector without a writer body', (_name, response) => {
    expect(FinancialPolicyPreparationRequestSchema.parse(response.selection)).toEqual(response.selection);
  });
  it.each(['environment', 'organizationId', 'responsibilityId', 'actorId', 'roles', 'sessionId', 'key', 'requestHash', 'nonce', 'mfaEvidenceId', 'verified', 'text', 'draft', 'bundle'])('rejects extra public/private request field %s', field => {
    for (const value of Object.values(examples())) expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...value.selection, [field]: 'forged' }).success).toBe(false);
  });
  it('allows missing material selectors but rejects omitted fields, duplicate document identities and withdrawal creation', () => {
    const f = examples();
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.draft.selection, document: null }).success).toBe(true);
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.governance.selection, assetKey: null, budgetDocument: null, approvalDocument: null }).success).toBe(true);
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.governance.selection, approvalDocument: f.governance.selection.budgetDocument }).success).toBe(false);
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.draft.selection, document: undefined }).success).toBe(false);
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.withdrawal.selection, previous: null }).success).toBe(false);
  });
  it('requires exact target IDs, target-bound predecessors and reserved writer identity compatibility', () => {
    for (const f of Object.values(examples())) for (const targetId of ['', 'a/b', 'a%2Fb', 'a?b', 'é', 'a'.repeat(129)])
      expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...f.selection, targetId }).success).toBe(false);
    for (const name of ['draft', 'withdrawal', 'governance'] as const) {
      const value = examples()[name].selection;
      expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...value, targetId: 'context' }).success).toBe(false);
    }
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...examples().document.selection, targetId: 'context' }).success).toBe(true);
    expect(FinancialPolicyPreparationRequestSchema.safeParse({ ...examples().draft.selection, previous: ref('other') }).success).toBe(false);
    expect(FinancialPolicyPreparationRequestSchema.safeParse(replace(examples().draft.selection, ['document', 'version'], '1')).success).toBe(false);
  });
  it('checks the encoded bound before interpreting large unknown fields and returns safe failure for non-JSON data', () => {
    const large = { ...examples().document.selection, extra: 'x'.repeat(FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES) };
    const result = FinancialPolicyPreparationRequestSchema.safeParse(large); expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('encoded byte limit');
    const circular: any = {}; circular.self = circular;
    expect(FinancialPolicyPreparationRequestSchema.safeParse(circular).success).toBe(false);
    expect(FinancialPolicyPreparationRequestSchema.safeParse(1n).success).toBe(false);
  });
});

describe('financial policy preparation selection and evaluated decisions', () => {
  it.each(Object.entries(examples()))('represents a structurally consistent %s response without authorizing it', (_name, value) => {
    expect(FinancialPolicyPreparationResponseSchema.parse(value)).toEqual(value);
  });
  it.each(['document', 'draft', 'governance'] as const)('represents exact %s revision with old membership and history', kind => {
    const value = revision(kind); expect(value.scope.actor.membershipVersion).not.toBe(value.target.record.record.actor.membershipVersion); expect(parses(value)).toBe(true);
  });
  it('allows an expired raw DRAFT and expired raw OPEN revision with newly reviewed future inputs still required', () => {
    expect(parses(revision('draft'))).toBe(true); expect(parses(revision('governance'))).toBe(true);
  });
  it('preserves latest OPEN revision when changed budget control makes its projection SUPERSEDED', () => {
    const value = revision('governance'); value.target.record.projection = { currentRecord: false, state: 'SUPERSEDED', blockers: [] };
    const current = acceptedContext(value);
    value.target.record.budgetConfiguration = { status: 'observed', control: current, currentBudgetConfiguration: false };
    expect(parses(value)).toBe(true);
    const unavailable = replace(value, ['target', 'record', 'budgetConfiguration'], { status: 'unavailable', control: null, currentBudgetConfiguration: null });
    expect(parses(unavailable)).toBe(true);
    expect(parses(replace(unavailable, ['target', 'record', 'projection'], { currentRecord: true, state: 'OPEN', blockers: [] }))).toBe(false);
    expect(parses(replace(value, ['target', 'record', 'budgetConfiguration', 'control'], control()))).toBe(false);
  });
  it('keeps withdrawal representable with stale historical documents, expired dates and unsupported old optional material', () => {
    const value: any = examples().withdrawal;
    value.target.record.record.draft.asset = pin();
    value.target.record.projection.blockers = ['ACCOUNT_MISSING', 'ASSET_CHANGED', 'DOCUMENT_CHANGED', 'DRAFT_EXPIRED', ...warnings, 'SCOPE_CHANGED'].sort();
    expect(parses(value)).toBe(true);
    for (const reason of ['SCOPE_CHANGED', 'DOCUMENT_CHANGED', 'ASSET_CHANGED', 'DRAFT_MATERIAL_UNSUPPORTED', 'DRAFT_EXPIRED', 'TRUST_UNAVAILABLE'])
      expect(parses({ ...value, decision: decision('withdraw_draft', [reason]) })).toBe(false);
    expect(parses({ ...value, material: { ...value.material, siteActive: false } })).toBe(false);
  });
  it.each(['document', 'draft', 'governance', 'withdrawal'] as const)('rejects reviewable %s with a contradictory original actor while preserving private denials', kind => {
    const value = structuredClone(kind === 'withdrawal' ? examples().withdrawal : revision(kind));
    const record = value.target.record.record;
    const originalActor = kind === 'document' ? record.actor : kind === 'governance' ? record.proposer : record.requester;
    expect(value.scope.actor.actorId).toBe(originalActor.actorId);
    value.decision = decision(value.selection.action, ['ORIGINAL_ACTOR_REQUIRED']); expect(parses(value)).toBe(true);
    value.decision = decision(value.selection.action); expect(parses(value)).toBe(true);
    record.actor.actorId = 'different_public_actor'; originalActor.actorId = 'different_public_actor';
    expect(parses(value)).toBe(false);
    // Necessary visible equality cannot establish hidden original-person predicates.
    value.decision = decision(value.selection.action, ['ORIGINAL_ACTOR_REQUIRED']); expect(parses(value)).toBe(true);
  });
  it.each(['document', 'draft', 'governance', 'withdrawal'] as const)('keeps missing nonnull %s predecessor opaque, never fresh-create absence', kind => {
    const value: any = kind === 'withdrawal' ? examples().withdrawal : revision(kind);
    value.target = unavailable(); value.decision = decision(value.selection.action, ['TARGET_UNAVAILABLE']); expect(parses(value)).toBe(true);
    expect(parses({ ...value, target: absent(), decision: decision(value.selection.action) })).toBe(false);
    expect(parses({ ...value, target: { ...unavailable(), latestReference: ref('fabricated') } })).toBe(false);
    expect(parses({ ...value, decision: decision(value.selection.action) })).toBe(false);
  });
  it('requires changed target reference and reason to agree without rewriting selected input', () => {
    const value = revision('document'), selected = structuredClone(value.selection);
    value.target = { state: 'changed', latestReference: ref('target_a', 2), record: null, historicalDocuments: [] };
    value.decision = decision('save_document', ['PREDECESSOR_CHANGED']); expect(parses(value)).toBe(true); expect(value.selection).toEqual(selected);
    for (const changed of [replace(value, ['target', 'latestReference'], ref('other', 2)), replace(value, ['target', 'latestReference'], selected.previous),
      replace(value, ['decision'], decision('save_document')), replace(value, ['target', 'record'], document('target_a'))]) expect(parses(changed)).toBe(false);
  });
  it.each([
    { action: 'withdraw_draft', state: 'blocked', reasons: ['ASSET_CHANGED'], requiredAuthentication: null },
    { action: 'save_document', state: 'reviewable', reasons: ['ROLE_REQUIRED'], requiredAuthentication: null },
    { action: 'save_document', state: 'blocked', reasons: [], requiredAuthentication: null },
    { action: 'save_document', state: 'not_evaluated', reasons: [], requiredAuthentication: null },
    { action: 'save_document', state: 'blocked', reasons: ['ELIGIBILITY_NOT_EVALUATED'], requiredAuthentication: null },
    { action: 'save_document', state: 'not_evaluated', reasons: ['ELIGIBILITY_NOT_EVALUATED', 'SERVICE_UNAVAILABLE'], requiredAuthentication: null },
    { action: 'save_document', state: 'blocked', reasons: ['SERVICE_UNAVAILABLE', 'SERVICE_UNAVAILABLE'], requiredAuthentication: null },
    { action: 'save_document', state: 'blocked', reasons: ['SITE_ACCESS_REQUIRED', 'ROLE_REQUIRED'], requiredAuthentication: null },
    { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: 'financial_policy_authorization' },
  ])('rejects an inconsistent decision $state/$action/$reasons', value => expect(FinancialPolicyPreparationDecisionSchema.safeParse(value).success).toBe(false));
  it('allows unevaluated action metadata only in its explicit state and never turns warnings into permission', () => {
    const value = examples().document;
    expect(parses({ ...value, decision: { ...decision('save_document'), state: 'not_evaluated', reasons: ['ELIGIBILITY_NOT_EVALUATED'] } })).toBe(true);
    expect(parses({ ...value, decision: decision('save_document', ['TRUST_UNAVAILABLE']) })).toBe(false);
    expect(parses({ ...value, configurationWarnings: [] })).toBe(false);
  });
});

describe('financial policy scoped preparation material', () => {
  it.each([
    [['responsibilityId'], null], [['selection', 'action'], 'propose_governance'], [['decision', 'action'], 'save_document'],
    [['material', 'action'], 'withdraw_draft'], [['material', 'draftScope', 'authority', 'responsibility', 'id'], 'other'],
    [['material', 'draftScope', 'site', 'id'], 'other'], [['material', 'siteActive'], false], [['scope', 'actionSiteIds'], []],
    [['material', 'document', 'record', 'organizationId'], 'other'], [['material', 'document', 'reference', 'recordHash'], 'f'.repeat(64)],
    [['material', 'document', 'projection'], { currentRecord: false, state: 'SUPERSEDED', blockers: [] }],
    [['material', 'asset'], pin()], [['material', 'trust'], {}], [['material', 'profile'], 'funded'],
  ] as [string[], unknown][])('rejects inconsistent draft material at %j', (path, replacement) => expect(parses(replace(examples().draft, path, replacement))).toBe(false));
  it('requires missing selected document state to be explicit, without promoting history to current terms', () => {
    const value: any = examples().draft; value.selection.document = null; value.material.document = null; value.decision = decision('save_draft', ['DOCUMENT_REQUIRED']); expect(parses(value)).toBe(true);
    value.selection.document = ref('mandate_doc'); expect(parses(value)).toBe(false);
    value.decision = decision('save_draft', ['DOCUMENT_CHANGED']); expect(parses(value)).toBe(true);
    value.material.document = document('mandate_doc'); expect(parses(value)).toBe(false);
  });
  it('keeps historical references separate from newly selected current draft material', () => {
    const value = revision('draft'); value.selection.document = ref('new_doc'); value.material.document = document('new_doc'); expect(parses(value)).toBe(true);
    expect(parses(replace(value, ['target', 'historicalDocuments', 0], document('new_doc')))).toBe(false);
    expect(parses(replace(value, ['target', 'historicalDocuments'], []))).toBe(false);
    expect(parses(replace(value, ['target', 'record', 'record', 'organizationId'], 'other'))).toBe(false);
    expect(parses(replace(value, ['target', 'latestReference', 'recordHash'], 'f'.repeat(64)))).toBe(false);
  });
  it('blocks rather than silently dropping optional references on an existing draft', () => {
    const value = revision('draft'); value.target.record.record.draft.asset = pin(); expect(parses(value)).toBe(false);
    value.decision = decision('save_draft', ['DRAFT_MATERIAL_UNSUPPORTED']); expect(parses(value)).toBe(true);
    value.target.record.record.draft.asset = null; expect(parses(value)).toBe(false);
  });
  it('rejects reviewable terminal drafts and governance while representing their blocked decisions', () => {
    const draftValue = revision('draft'); draftValue.selection.previous = ref('target_a', 2); draftValue.target.latestReference = ref('target_a', 2);
    draftValue.target.record.reference = ref('target_a', 2); Object.assign(draftValue.target.record.record, { version: 2, predecessor: ref('target_a'), state: 'WITHDRAWN' });
    draftValue.target.record.projection = { currentRecord: true, state: 'WITHDRAWN', blockers: ['DRAFT_WITHDRAWN', ...warnings] }; expect(parses(draftValue)).toBe(false);
    draftValue.decision = decision('save_draft', ['DRAFT_WITHDRAWN']); expect(parses(draftValue)).toBe(true);
    const gov = revision('governance'); gov.selection.previous = ref('target_a', 2); gov.target.latestReference = ref('target_a', 2); gov.target.record.reference = ref('target_a', 2);
    Object.assign(gov.target.record.record, { version: 2, predecessor: ref('target_a'), state: 'REJECTED' }); gov.target.record.projection.state = 'REJECTED'; expect(parses(gov)).toBe(false);
    gov.decision = decision('propose_governance', ['CURRENT_RECORD_REQUIRED']); expect(parses(gov)).toBe(true);
  });
  it('requires an exact maximum-version record for version exhaustion and never offers another revision', () => {
    const value = revision('document'), version = 2_147_483_647;
    value.selection.previous = ref('target_a', version); value.target.latestReference = ref('target_a', version); value.target.record = document('target_a', 'financial_mandate', true, version);
    expect(parses(value)).toBe(false); value.decision = decision('save_document', ['VERSION_EXHAUSTED']); expect(parses(value)).toBe(true);
    expect(parses({ ...examples().document, decision: decision('save_document', ['VERSION_EXHAUSTED']) })).toBe(false);
  });
  it('allows finance to receive a blocked organization document/proposal decision but never an Operations disclosure', () => {
    const f = examples(); const doc: any = f.document;
    doc.responsibilityId = null; doc.selection.purpose = 'budget_policy'; Object.assign(doc.material, { purpose: 'budget_policy', draftScope: null, siteActive: null });
    for (const value of [doc, f.governance]) {
      value.scope.roles = ['finance']; value.decision = decision(value.selection.action, ['ROLE_REQUIRED']); expect(parses(value)).toBe(true);
      expect(parses({ ...value, decision: decision(value.selection.action) })).toBe(false);
      expect(parses(replace(value, ['scope', 'roles'], ['operations']))).toBe(false);
    }
  });
  it.each([
    [['material', 'budgetDocument', 'record', 'purpose'], 'approval_policy'], [['material', 'budgetDocument', 'record', 'responsibilityId'], 'responsibility_a'],
    [['material', 'control', 'budgetAccountId'], 'f'.repeat(64)], [['material', 'asset', 'pin', 'key'], 'f'.repeat(64)],
    [['material', 'asset', 'mint'], FINANCE_DEVNET_ASSET.tokenProgram], [['material', 'asset', 'decimals'], 9],
    [['material', 'asset'], null], [['material', 'eligibleActionSites'], []], [['scope', 'siteIds'], []],
  ] as [string[], unknown][])('rejects inconsistent governance material at %j', (path, value) => expect(parses(replace(examples().governance, path, value))).toBe(false));
  it('represents absent versus unavailable selected asset without partial budget context', () => {
    const value: any = examples().governance;
    Object.assign(value.material, { asset: null, budgetAccountId: null, control: null, acceptedConfiguration: null, periods: [] });
    value.selection.assetKey = null; value.decision = decision('propose_governance', ['ASSET_MISSING']); expect(parses(value)).toBe(true);
    value.selection.assetKey = assetKey; expect(parses(value)).toBe(false);
    value.decision = decision('propose_governance', ['ASSET_CHANGED']); expect(parses(value)).toBe(true);
    value.material.control = control(); expect(parses(value)).toBe(false);
  });
  it('requires bounded, ordered, disjoint periods and exactly scoped unique active-site references', () => {
    const value: any = examples().governance; value.material.periods = Array.from({ length: 50 }, (_, i) => period(i)); expect(parses(value)).toBe(true);
    for (const periods of [[period(), period()], [period(1), period()], [period(), { ...period(), id: 'f'.repeat(64) }], Array.from({ length: 51 }, (_, i) => period(i))])
      expect(parses(replace(value, ['material', 'periods'], periods))).toBe(false);
    const sites = Array.from({ length: 100 }, (_, i) => ({ id: `site_${String(i).padStart(3, '0')}`, generation: i, recordHash: hash }));
    value.scope.siteIds = sites.map(s => s.id); value.scope.actionSiteIds = sites.map(s => s.id); value.material.eligibleActionSites = sites; expect(parses(value)).toBe(true);
    expect(parses(replace(value, ['material', 'eligibleActionSites'], [...sites].reverse()))).toBe(false);
    expect(parses(replace(value, ['material', 'eligibleActionSites'], [...sites, { id: 'site_100', generation: 0, recordHash: hash }]))).toBe(false);
  });
  it('retains the stable budget identity for proposal revision', () => {
    const value = revision('governance'); value.material.budgetAccountId = 'f'.repeat(64); value.material.control.budgetAccountId = 'f'.repeat(64);
    expect(parses(value)).toBe(false); value.decision = decision('propose_governance', ['GOVERNANCE_CHANGED']); expect(parses(value)).toBe(true);
    value.material.budgetAccountId = accountId; value.material.control.budgetAccountId = accountId; expect(parses(value)).toBe(false);
  });
  it('requires complete current accepted configuration/control/period links', () => {
    const value: any = examples().governance; acceptedContext(value); expect(parses(value)).toBe(true);
    for (const [path, replacement] of [
      [['material', 'acceptedConfiguration'], null], [['material', 'periods'], []], [['material', 'acceptedConfiguration', 'record', 'organizationId'], 'foreign'],
      [['material', 'acceptedConfiguration', 'budgetConfiguration', 'currentBudgetConfiguration'], false],
      [['material', 'acceptedConfiguration', 'reference', 'recordHash'], 'f'.repeat(64)],
    ] as [string[], unknown][]) expect(parses(replace(value, path, replacement))).toBe(false);
  });
});

describe('financial policy preparation privacy and structural bounds', () => {
  it.each(['subject', 'externalMembershipId', 'sessionId', 'identityEvidence', 'mfaEvidence', 'nonce', 'verified', 'qualified', 'balance', 'permissionToken'])('rejects private/unsupported field %s at each new boundary', field => {
    const value = revision('draft');
    for (const path of [[], ['scope', 'actor'], ['selection'], ['decision'], ['target'], ['material'], ['target', 'record', 'record'], ['material', 'document', 'record']]) {
      const target = path.reduce((v: any, key) => v[key], value);
      expect(parses(path.length ? replace(value, path, { ...target, [field]: 'forged' }) : { ...value, [field]: 'forged' })).toBe(false);
    }
  });
  it('preserves false/null invariants and bounded observation structure without claiming real-time freshness', () => {
    const value = examples().draft;
    for (const [path, replacement] of [[['effectiveAuthority'], true], [['financialState'], 'ACTIVE'], [['observation', 'expiresAt'], '2026-11-15T12:00:20.001Z'],
      [['observation', 'expiresAt'], value.observation.observedAt], [['configurationWarnings'], [...warnings].reverse()]] as [string[], unknown][])
      expect(parses(replace(value, path, replacement))).toBe(false);
    expect(parses(replace(value, ['observation'], { observedAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:20.000Z' }))).toBe(true);
  });
  it('preserves maximum Unicode current and historical terms without text normalization', () => {
    const value = revision('draft'), text = '🧵'.repeat(20_000);
    value.material.document.record.text = text; value.target.historicalDocuments[0].record.text = text;
    const parsed = FinancialPolicyPreparationResponseSchema.parse(value); expect(JSON.stringify(parsed)).toContain(text);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES);
    for (const text of ['🧵'.repeat(20_001), 'Cafe\u0301', 'a\rb', '\ud800']) expect(parses(replace(value, ['material', 'document', 'record', 'text'], text))).toBe(false);
  });
  it('rejects over-limit encoded responses before nested schema parsing, including multibyte content', () => {
    const value = { ...examples().draft, unknown: '🧵'.repeat(FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES / 4) };
    const result = FinancialPolicyPreparationResponseSchema.safeParse(value); expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('encoded byte limit');
  });
});
