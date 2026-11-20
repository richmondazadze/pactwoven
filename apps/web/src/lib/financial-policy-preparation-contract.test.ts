import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinancialPolicyPreparationResponseSchema } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { FinancialPolicyBootstrapSchema, qualifyFinancialContext } from './financial-policy-context';
import { assertQualifiedFinancialPolicyPreparation, parseFinancialPolicyPreparationSelection, qualifyFinancialPolicyPreparation } from './financial-policy-preparation-contract';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), hash = 'a'.repeat(64);
const ref = (id: string, version = 1) => ({ id, version, recordHash: hash });
async function fixture() {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a', apiBase: 'https://api.example.test',
    responsibilityId: 'responsibility_a', userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a' } });
  const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const authority = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const basis = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: 'development', organizationId: 'org_a' } }),
    site: { id: 'site_a', generation: 0, recordHash: hash } };
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const observation = await qualifyFinancialContext({ ...envelope, kind: 'responsibility', responsibilityId: 'responsibility_a', configurationVisibility: 'full', draftScope: basis,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] }, bootstrap, at, 100);
  const actor = { actorId: 'actor_a', membershipVersion: 1 }, common = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a',
    version: 1, predecessor: null, actor, organizationEpoch: 1, operationId: '00000000-0000-0000-0000-000000000001', createdAt: iso(at - 86400000) };
  const text = 'Exact mandate. Café 🧵';
  const document = { reference: ref('mandate_doc'), record: { ...common, id: 'mandate_doc', kind: 'document', purpose: 'financial_mandate', text,
    contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) }, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null };
  const response: any = { ...envelope, responsibilityId: 'responsibility_a', selection: { schemaVersion: 1, action: 'save_draft', targetId: 'draft_a', previous: null, document: ref('mandate_doc') },
    decision: { action: 'save_draft', state: 'reviewable', reasons: [], requiredAuthentication: null },
    target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
    material: { action: 'save_draft', profile: 'incomplete', draftScope: basis, siteActive: true, document, asset: null, account: null, governance: null, trust: null },
    configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] };
  function revision() {
    const result = structuredClone(response); result.selection.previous = ref('draft_a');
    const draft = { scope: basis, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
      documents: [{ ...ref('mandate_doc'), purpose: 'financial_mandate' }], asset: null, account: null, governance: null, trust: null,
      startsAt: iso(at - 86400000), expiresAt: iso(at - 1000) };
    result.target = { state: 'exact', latestReference: ref('draft_a'), record: { reference: ref('draft_a'), record: { ...common, id: 'draft_a', kind: 'draft', state: 'DRAFT', requester: actor, draft },
      projection: { currentRecord: true, state: 'EXPIRED', blockers: ['DRAFT_EXPIRED', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] }, budgetConfiguration: null }, historicalDocuments: [structuredClone(document)] };
    result.target.historicalDocuments[0].projection = { currentRecord: false, state: 'SUPERSEDED', blockers: [] }; return result;
  }
  return { bootstrap, observation, response, revision, document, basis };
}
afterEach(() => vi.restoreAllMocks());

describe('preparation public material qualification', () => {
  it('qualifies exact current material and marks only returned objects', async () => {
    const f = await fixture(), result = await qualifyFinancialPolicyPreparation(f.response, f.response.selection, f.observation, at, 100);
    expect(result.response.material).toEqual(f.response.material); expect(result.expiresAt).toBe(at + 19000); expect(Object.isFrozen(result.response)).toBe(true);
    expect(() => assertQualifiedFinancialPolicyPreparation(result)).not.toThrow(); expect(() => assertQualifiedFinancialPolicyPreparation({ ...result })).toThrow();
  });
  it.each(['key', 'text', 'actorId', 'requestHash', 'responsibilityId', 'nonce', 'qualified'])(
    'does not accept extra selector field %s', async field => {
      const f = await fixture(); expect(() => parseFinancialPolicyPreparationSelection({ ...f.response.selection, [field]: 'forged' }, 'responsibility_a')).toThrow();
    });
  it.each(['withdraw_draft', 'propose_governance', 'accept_governance'])(
    'does not expand to %s from the wider public action family', async action => {
      const f = await fixture(); expect(() => parseFinancialPolicyPreparationSelection({ ...f.response.selection, action }, 'responsibility_a')).toThrow();
    });
  it.each(['membership', 'epoch', 'role', 'site', 'target', 'selection-hash', 'route', 'private'])(
    'rejects mismatched %s even when the surrounding response looks valid', async mode => {
      const f = await fixture(), raw = structuredClone(f.response);
      if (mode === 'membership') raw.scope.actor.membershipVersion++;
      if (mode === 'epoch') raw.scope.organizationEpoch++;
      if (mode === 'role') raw.scope.roles = ['finance'];
      if (mode === 'site') raw.scope.siteIds.push('site_b');
      if (mode === 'target') raw.selection.targetId = 'other_draft';
      if (mode === 'selection-hash') { raw.selection.document.recordHash = 'b'.repeat(64); raw.material.document.reference.recordHash = 'b'.repeat(64); }
      if (mode === 'route') raw.responsibilityId = 'other';
      if (mode === 'private') raw.subject = 'private';
      await expect(qualifyFinancialPolicyPreparation(raw, f.response.selection, f.observation, at, 100)).rejects.toBeDefined();
    });
  it('keeps a still-raw expired DRAFT reviewable without changing its historical text or membership', async () => {
    const f = await fixture(), raw = f.revision();
    const value = await qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100);
    expect(value.response.decision.state).toBe('reviewable');
    if (value.response.target.state !== 'exact') throw Error('fixture');
    expect(value.response.target.record.record.actor.membershipVersion).toBe(1);
    expect(value.response.target.historicalDocuments[0]?.projection.currentRecord).toBe(false);
  });
  it.each(['content-hash', 'historical-hash', 'authority-hash', 'conflicting-copy', 'reference-copy'])(
    'rejects %s instead of trusting a hash-shaped value', async mode => {
      const f = await fixture(), raw = f.revision();
      if (mode === 'content-hash') raw.material.document.record.contentHash = 'b'.repeat(64);
      if (mode === 'historical-hash') raw.target.historicalDocuments[0].record.contentHash = 'b'.repeat(64);
      if (mode === 'authority-hash') raw.target.record.record.draft.scope.authorityHash = 'b'.repeat(64);
      if (mode === 'conflicting-copy') {
        raw.material.document.record.text = 'Different current text under the same immutable ref';
        raw.material.document.record.contentHash = await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: raw.material.document.record.text });
        expect(FinancialPolicyPreparationResponseSchema.safeParse(raw).success).toBe(true);
      }
      if (mode === 'reference-copy') {
        raw.selection.document.recordHash = 'b'.repeat(64); raw.material.document.reference.recordHash = 'b'.repeat(64);
        expect(FinancialPolicyPreparationResponseSchema.safeParse(raw).success).toBe(true);
      }
      await expect(qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100)).rejects.toBeDefined();
    });
  it('accepts a consistently opaque private reference without pretending to reconstruct its private hash', async () => {
    const f = await fixture(); f.response.selection.document.recordHash = 'f'.repeat(64); f.response.material.document.reference.recordHash = 'f'.repeat(64);
    expect((await qualifyFinancialPolicyPreparation(f.response, f.response.selection, f.observation, at, 100)).response.material).toEqual(f.response.material);
  });
  it('requires a new GET context when preparation observes a newer correctly hashed basis', async () => {
    const f = await fixture(), raw = structuredClone(f.response); raw.material.draftScope.authority.generation++;
    raw.material.draftScope.authorityHash = await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: {
      ...raw.material.draftScope.authority, environment: 'development', organizationId: 'org_a' } });
    await expect(qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100)).rejects.toMatchObject({ code: 'expired' });
  });
  it.each(['blocked', 'not_evaluated', 'changed', 'unavailable'])('represents %s without making it a write capability', async mode => {
    const f = await fixture(), raw = structuredClone(f.response);
    raw.decision.state = mode === 'not_evaluated' ? mode : 'blocked';
    raw.decision.reasons = [mode === 'not_evaluated' ? 'ELIGIBILITY_NOT_EVALUATED' : mode === 'changed' ? 'PREDECESSOR_CHANGED' : mode === 'unavailable' ? 'TARGET_UNAVAILABLE' : 'SERVICE_UNAVAILABLE'];
    if (mode === 'changed') raw.target = { state: 'changed', latestReference: ref('draft_a'), record: null, historicalDocuments: [] };
    if (mode === 'unavailable') raw.target.state = 'unavailable';
    expect((await qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100)).response.decision.state).not.toBe('reviewable');
  });
  it('preserves R2 original-person distinction: necessary public equality still permits a server refusal', async () => {
    const f = await fixture(), raw = f.revision(); raw.decision = { ...raw.decision, state: 'blocked', reasons: ['ORIGINAL_ACTOR_REQUIRED'] };
    expect((await qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100)).response.decision.state).toBe('blocked');
    raw.decision.state = 'reviewable'; raw.decision.reasons = []; raw.target.record.record.requester.actorId = 'other_actor';
    await expect(qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, at, 100)).rejects.toBeDefined();
  });
  it('qualifies maximum Unicode text without rewriting or truncating it', async () => {
    const f = await fixture(), text = '🧵'.repeat(20000); f.response.material.document.record.text = text;
    f.response.material.document.record.contentHash = await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text });
    const result = await qualifyFinancialPolicyPreparation(f.response, f.response.selection, f.observation, at, 100);
    if (result.response.material.action !== 'save_draft') throw Error('fixture'); expect(result.response.material.document?.record.text).toBe(text);
  });
  it('detaches response material before hashing and calls the guard after asynchronous work', async () => {
    const f = await fixture(); let valid = true;
    const work = qualifyFinancialPolicyPreparation(f.response, f.response.selection, f.observation, at, 100, () => { if (!valid) throw Error('closed'); });
    f.response.material.document.record.text = 'Changed caller object'; valid = false;
    await expect(work).rejects.toThrow('closed');
  });
  it.each(['future', 'expired', 'clock', 'monotonic'])('rejects invalid %s observation timing', async mode => {
    const f = await fixture(), raw = structuredClone(f.response);
    if (mode === 'future') raw.observation = { observedAt: iso(at + 1), expiresAt: iso(at + 1000) };
    if (mode === 'expired') raw.observation = { observedAt: iso(at - 2000), expiresAt: iso(at) };
    await expect(qualifyFinancialPolicyPreparation(raw, raw.selection, f.observation, mode === 'clock' ? NaN : at, mode === 'monotonic' ? -1 : 100)).rejects.toBeDefined();
  });
});
