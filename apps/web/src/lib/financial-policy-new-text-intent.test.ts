import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, financialPolicyHttpRoute } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { digestFinancialPolicyNewTextMaterial } from './financial-policy-new-text-intent';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), hash = 'a'.repeat(64);
function fixture() {
  const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const basis = { authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' },
    generation: 3, family: 'legacy', legacyHead: { mandateId: 'mandate_a', mandateVersion: 2, mandateEpoch: 4, hash, state: 'ACTIVE' } },
    authorityHash: hash, site: { id: 'site_a', generation: 2, recordHash: hash } };
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at), expiresAt: iso(at + 20000) }, effectiveAuthority: false, financialState: null };
  const selection = { schemaVersion: 1, action: 'save_document', targetId: 'new_text', previous: null, purpose: 'financial_mandate' };
  const asset = { ...FINANCE_DEVNET_ASSET, decimals: 6, policy: 'solana-original-devnet-usdc-v1',
    pin: { key: 'b'.repeat(64), version: 1, recordHash: hash, financialUseEpoch: 0 } };
  const period = { id: 'c'.repeat(64), startsAt: iso(at - 10000), endsAt: iso(at + 100000) };
  const accepted = { id: 'governance_a', version: 2, recordHash: 'd'.repeat(64) };
  const control = { budgetAccountId: 'e'.repeat(64), generation: 1, accepted };
  const common = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 },
    organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: iso(at - 1000) };
  const document = { reference: { id: 'existing_text', version: 1, recordHash: hash },
    record: { ...common, id: 'existing_text', version: 1, predecessor: null, kind: 'document', responsibilityId: 'responsibility_a',
      purpose: 'financial_mandate', text: 'Existing exact terms.', contentHash: hash },
    projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null };
  const acceptedConfiguration = { reference: accepted, record: { ...common, id: accepted.id, version: accepted.version,
    predecessor: { ...accepted, version: 1 }, kind: 'governance', responsibilityId: null, state: 'ACCEPTED',
    proposer: { actorId: 'proposer_a', membershipVersion: 1 }, expiresAt: iso(at + 60000),
    expectedControl: { budgetAccountId: control.budgetAccountId, generation: 0, accepted: null },
    bundle: { budgetAccountId: control.budgetAccountId, asset: asset.pin, category: 'supplier_principal',
      limits: { perOperation: '100', perResponsibility: '200', perPeriod: '300' }, period,
      approval: { requesterRoles: ['operations'], approverRoles: ['owner'], independent: true, actionSiteIds: ['site_a'],
        action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 120, maximumApprovalAgeSeconds: 120 },
      documents: [{ id: 'approval_a', version: 1, recordHash: hash, purpose: 'approval_policy' },
        { id: 'budget_a', version: 1, recordHash: hash, purpose: 'budget_policy' }] } },
    projection: { currentRecord: true, state: 'ACCEPTED', blockers: [] }, budgetConfiguration: { status: 'observed', control, currentBudgetConfiguration: true } };
  return structuredClone({ bootstrap: { environment: 'development', organizationId: 'org_a', actorId: 'actor_a', apiBase: 'https://api.example.test',
    responsibilityId: 'responsibility_a', userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a' } },
    action: { kind: 'save_document', id: 'new_text', responsibilityId: 'responsibility_a',
      route: financialPolicyHttpRoute({ kind: 'save_document', id: 'new_text', responsibilityId: 'responsibility_a' }),
      input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'financial_mandate', text: 'Café\nExact reviewed terms.\n' } },
    selection, context: { ...envelope, kind: 'responsibility', responsibilityId: 'responsibility_a', configurationVisibility: 'full', draftScope: basis,
      asset, control, acceptedConfiguration, periods: [period], documents: [document],
      actions: [{ action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null }],
      blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] },
    preparation: { ...envelope, responsibilityId: 'responsibility_a', selection,
      decision: { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null },
      target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
      material: { action: 'save_document', purpose: 'financial_mandate', organizationEpoch: 2, draftScope: basis, siteActive: true },
      configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] } });
}
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]));
  return value;
}
function objectPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => objectPaths(item, [...path, i]));
  return [path, ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key]))];
}
function leafPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leafPaths(item, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...path, key]));
  return [path];
}
function parent(value: any, path: (string | number)[]) { return path.slice(0, -1).reduce((v, key) => v[key], value); }
afterEach(() => vi.restoreAllMocks());
describe('complete private new-text comparison material', () => {
  it('uses the fixed canonical namespace, all material and only exact root observation exclusions', async () => {
    const f = fixture(), { observation: a, ...context } = f.context, { observation: b, ...preparation } = f.preparation;
    const expected = await commandDigest({ namespace: 'pactwoven:financial-new-text-review-intent:v1', schemaVersion: 1,
      bootstrap: f.bootstrap, action: f.action, selection: f.selection, context, preparation });
    expect(await digestFinancialPolicyNewTextMaterial(f)).toBe(expected);
    expect(await digestFinancialPolicyNewTextMaterial(reversedKeys(f))).toBe(expected);
    for (const root of ['context', 'preparation'] as const) {
      const changed = fixture(); changed[root].observation = { observedAt: iso(at + 5000), expiresAt: iso(at + 24000) };
      expect(await digestFinancialPolicyNewTextMaterial(changed)).toBe(expected);
    }
    expect(a).toBeDefined(); expect(b).toBeDefined();
  });
  it.each(objectPaths(fixture()).map(path => [path.join('.') || 'packet', path] as const))('rejects unknown fields at %s', async (_name, path) => {
    const f: any = fixture(), target = path.reduce((v: any, key) => v[key], f); target.unreviewedField = true;
    await expect(async () => digestFinancialPolicyNewTextMaterial(f)).rejects.toBeDefined();
  });
  it.each(leafPaths(fixture()).filter(path => !(path.length === 3 && path[1] === 'observation')).map(path => [path.join('.'), path] as const))(
    'binds or rejects changed semantic leaf %s', async (_name, path) => {
      const f: any = fixture(), expected = await digestFinancialPolicyNewTextMaterial(f), holder = parent(f, path), key = path.at(-1)!;
      const old = holder[key]; holder[key] = old === null ? 'changed' : typeof old === 'boolean' ? !old : typeof old === 'number' ? old + 1 : `${old}x`;
      let changed: string | null = null; try { changed = await digestFinancialPolicyNewTextMaterial(f); } catch { /* Closed-schema rejection also prevents equality. */ }
      expect(changed).not.toBe(expected);
    });
  it('detects contract-valid changes in membership, business dates, complete text and array content', async () => {
    const baseline = await digestFinancialPolicyNewTextMaterial(fixture());
    const membership = fixture(); membership.context.scope.actor.membershipVersion++; membership.preparation.scope.actor.membershipVersion++;
    expect(await digestFinancialPolicyNewTextMaterial(membership)).not.toBe(baseline);
    const expiry = fixture(); expiry.context.acceptedConfiguration.record.expiresAt = iso(at + 65000);
    expect(await digestFinancialPolicyNewTextMaterial(expiry)).not.toBe(baseline);
    const created = fixture(); created.context.documents[0]!.record.createdAt = iso(at - 2000);
    expect(await digestFinancialPolicyNewTextMaterial(created)).not.toBe(baseline);
    const text = fixture(); text.action.input.text += '\n'; expect(await digestFinancialPolicyNewTextMaterial(text)).not.toBe(baseline);
    const sites = fixture(); for (const scope of [sites.bootstrap, sites.context.scope, sites.preparation.scope]) scope.siteIds = ['site_a', 'site_b'];
    expect(await digestFinancialPolicyNewTextMaterial(sites)).not.toBe(baseline);
    sites.bootstrap.siteIds.reverse(); await expect(async () => digestFinancialPolicyNewTextMaterial(sites)).rejects.toBeDefined();
  });
  it.each(['Cafe\u0301', 'Café\r\nTerms', 'Café\rTerms'])('does not renormalize input at acknowledgment or save: %j', async text => {
    const f = fixture(); f.action.input.text = text;
    await expect(async () => digestFinancialPolicyNewTextMaterial(f)).rejects.toBeDefined();
  });
  it('clears its application-owned bytes immediately and retains no packet in an async commandDigest frame', async () => {
    let finish!: (value: ArrayBuffer) => void, received: Uint8Array | null = null;
    const pending = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, bytes) => { received = bytes as Uint8Array; return pending; });
    const result = digestFinancialPolicyNewTextMaterial(fixture());
    expect(digest).toHaveBeenCalledOnce(); expect(received).not.toBeNull();
    expect(Array.from(received! as Uint8Array).every(byte => byte === 0)).toBe(true);
    finish(new Uint8Array(32).buffer); expect(await result).toBe('0'.repeat(64));
  });
});
