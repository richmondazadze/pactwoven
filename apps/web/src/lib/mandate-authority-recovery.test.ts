import { describe, expect, it } from 'vitest';
import { assertAuthorityRecovery, authorityRecoveryKey, authorityWork, listAuthorityRecovery, locatorFromAuthorityCapsule, MandateAuthorityLocatorSchema, readAuthorityRecovery, removeAuthorityRecovery, storeAuthorityRecovery, type MandateAuthorityLocator } from './mandate-authority-recovery';
import { createAuthorityCapsule } from './mandate-authority';
import { decisionTestCase, mandateFixtureNow } from './mandates.test-fixtures';
import { createMandateWorkCoordinator } from './mandate-work-coordination';
const scope = { userId: 'user_a', externalOrganizationId: 'external_org', apiBase: 'https://api.example.test', organizationId: 'org_a', environment: 'development' as const, actorId: 'actor_a' };
const locator: MandateAuthorityLocator = { version: 1, scope, responsibilityId: 'responsibility_a', kind: 'mandate.pause', key: 'original_authority_key', mandate: { id: 'mandate_a', version: 2, hash: 'a'.repeat(64) }, head: { mandateId: 'mandate_a', mandateVersion: 2, mandateEpoch: 7, hash: 'b'.repeat(64) }, responsibility: { id: 'responsibility_a', version: 3, siteId: 'site_a', hash: 'c'.repeat(64) }, expectedOrganizationEpoch: 4, commandHash: 'd'.repeat(64), intentHash: 'e'.repeat(64), expectedTarget: { kind: 'authority', id: 'mandate_a', version: 8, hash: 'f'.repeat(64) } };
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
describe('minimal multikind authority originals', () => {
  it('retains same-key pause, revoke and future resume as separate original records', () => {
    const store = storage(); const originals = ['mandate.pause', 'mandate.revoke', 'mandate.resume'].map(kind => MandateAuthorityLocatorSchema.parse({ ...locator, kind })); for (const original of originals) storeAuthorityRecovery(store, original);
    expect(listAuthorityRecovery(store, scope)).toEqual({ blocked: false, locators: originals }); expect(new Set(originals.map(authorityRecoveryKey)).size).toBe(3); expect(originals.map(authorityWork).map(work => [work.kind, work.targetId, work.phase])).toEqual([['PAUSE', 'mandate_a', 'pending'], ['REVOKE', 'mandate_a', 'pending'], ['RESUME', 'mandate_a', 'pending']]);
    expect(removeAuthorityRecovery(store, originals[1]!)).toBe(true); expect(readAuthorityRecovery(store, originals[1]!).state).toBe('empty'); expect(assertAuthorityRecovery(store, originals[0]!)).toEqual(originals[0]); expect(assertAuthorityRecovery(store, originals[2]!)).toEqual(originals[2]);
  });
  it('persists only references, hashes and minimal original scope', () => {
    const store = storage(); storeAuthorityRecovery(store, locator); const text = store.getItem(authorityRecoveryKey(locator))!;
    expect(JSON.parse(text)).toEqual(locator); for (const field of ['reason', 'sessionId', 'roles', 'intent', 'observation', 'token', 'proof', 'password']) expect(Object.hasOwn(JSON.parse(text), field)).toBe(false);
    expect(() => storeAuthorityRecovery(store, { ...locator, reason: 'private' } as MandateAuthorityLocator)).toThrow(); expect(assertAuthorityRecovery(store, locator)).toEqual(locator);
  });
  it.each(['mandate', 'head-version', 'responsibility', 'target-id', 'target-epoch', 'overflow', 'extra-scope'] as const)('rejects inconsistent %s locator identity', change => {
    const value = structuredClone(locator); if (change === 'mandate') value.mandate.id = 'other_mandate'; if (change === 'head-version') value.head.mandateVersion++; if (change === 'responsibility') value.responsibility.id = 'other_responsibility'; if (change === 'target-id') value.expectedTarget.id = 'other_mandate'; if (change === 'target-epoch') value.expectedTarget.version++; if (change === 'overflow') { value.head.mandateEpoch = 2_147_483_647; value.expectedTarget.version = 2_147_483_648; } if (change === 'extra-scope') Object.assign(value.scope, { sessionId: 'not_persistent' }); expect(MandateAuthorityLocatorSchema.safeParse(value).success).toBe(false);
  });
  it('never overwrites an occupied exact kind/key or removes a changed original', () => {
    const store = storage(); storeAuthorityRecovery(store, locator); const replacement = { ...locator, commandHash: '0'.repeat(64) }; expect(() => storeAuthorityRecovery(store, replacement)).toThrow(); expect(removeAuthorityRecovery(store, replacement)).toBe(false); expect(assertAuthorityRecovery(store, locator)).toEqual(locator);
  });
  it('scope-address isolation retains another actor/organization and unrelated recovery namespaces', () => {
    const store = storage(), foreign = { ...locator, scope: { ...scope, actorId: 'other_actor' } }; storeAuthorityRecovery(store, locator); storeAuthorityRecovery(store, foreign); store.setItem('pactwoven:mandate-recovery:v1:other', 'original_decision'); store.setItem('pactwoven:mandate-authoring:v1:other', 'original_documents');
    expect(listAuthorityRecovery(store, scope).locators).toEqual([locator]); expect(removeAuthorityRecovery(store, locator)).toBe(true); expect(assertAuthorityRecovery(store, foreign)).toEqual(foreign); expect(store.length).toBe(3);
  });
  it('keeps readable originals beside malformed addresses and blocks new writes', () => {
    const store = storage(); storeAuthorityRecovery(store, locator); store.setItem('pactwoven:mandate-authority:v1:%not-json', 'broken'); expect(listAuthorityRecovery(store, scope)).toEqual({ blocked: true, locators: [locator] }); expect(() => storeAuthorityRecovery(store, { ...locator, key: 'another_original_key' })).toThrow(); expect(assertAuthorityRecovery(store, locator)).toEqual(locator);
  });
  it.each(['null', 'read-failure', 'bad-json', 'foreign-body', 'write-failure', 'failed-readback'] as const)('treats %s storage as unresolved without clearing originals', change => {
    const store = storage(); if (change === 'null') { expect(readAuthorityRecovery(null, locator).state).toBe('blocked'); expect(() => storeAuthorityRecovery(null, locator)).toThrow(); return; }
    if (change === 'read-failure') store.getItem = () => { throw new Error('denied'); };
    if (change === 'bad-json') store.setItem(authorityRecoveryKey(locator), '{'); if (change === 'foreign-body') store.setItem(authorityRecoveryKey(locator), JSON.stringify({ ...locator, scope: { ...scope, actorId: 'other_actor' } }));
    if (change === 'write-failure') store.setItem = () => { throw new Error('denied'); }; if (change === 'failed-readback') store.setItem = () => {};
    expect(() => storeAuthorityRecovery(store, locator)).toThrow(); expect(removeAuthorityRecovery(store, locator)).toBe(false);
  });
  it('reports failed exact removal without deleting another pending kind', () => { const store = storage(), other = { ...locator, kind: 'mandate.revoke' as const }; storeAuthorityRecovery(store, locator); storeAuthorityRecovery(store, other); store.removeItem = () => {}; expect(removeAuthorityRecovery(store, locator)).toBe(false); expect(assertAuthorityRecovery(store, locator)).toEqual(locator); expect(assertAuthorityRecovery(store, other)).toEqual(other); });
  it('applies existing coordinator stop rules to every retained authority record', () => {
    const store = storage(); storeAuthorityRecovery(store, locator); const work = createMandateWorkCoordinator(() => { const list = listAuthorityRecovery(store, scope); return { blocked: list.blocked, records: list.locators.map(authorityWork) }; });
    expect(() => work.acquire({ ...authorityWork(locator), key: 'duplicate_pause_key', action: 'send', hasHead: true, eligible: true })).toThrow(); const revoke = work.acquire({ ...authorityWork({ ...locator, kind: 'mandate.revoke' }), action: 'send', hasHead: true, eligible: true }); work.release(revoke);
    storeAuthorityRecovery(store, { ...locator, kind: 'mandate.revoke' }); expect(() => work.acquire({ ...authorityWork(locator), key: 'replacement_pause_key', action: 'send', hasHead: true, eligible: true })).toThrow(); const original = work.acquire({ ...authorityWork(locator), action: 'retry' }); work.assert(original); work.release(original);
  });
});

it('maps a fully verified RESUME capsule to its existing distinct minimal storage address', async () => {
  const f = await decisionTestCase('AUTHORIZE'), review = structuredClone(f.outcomeReview), at = mandateFixtureNow + 2000;
  review.envelope.observedAt = new Date(at).toISOString(); review.envelope.head!.state = 'PAUSED'; review.envelope.head!.mandateEpoch = 2;
  review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; review.envelope.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
  const capsule = await createAuthorityCapsule(f.scope, { data: review, receivedAt: at, receivedMonotonic: 0 }, 'RESUME', 'Private exact reason.', 'same_original_key', at), original = locatorFromAuthorityCapsule(capsule), store = storage();
  expect(original.kind).toBe('mandate.resume'); expect(authorityWork(original).kind).toBe('RESUME');
  const pause = { ...original, kind: 'mandate.pause' as const }, revoke = { ...original, kind: 'mandate.revoke' as const };
  for (const value of [original, pause, revoke]) storeAuthorityRecovery(store, value);
  const raw = store.getItem(authorityRecoveryKey(original))!; expect(JSON.parse(raw)).toEqual(original); expect(raw).not.toContain('Private exact reason.'); expect(raw).not.toContain('clerk_session'); expect(raw).not.toContain('verifiedAt');
  expect(removeAuthorityRecovery(store, original)).toBe(true); expect(listAuthorityRecovery(store, f.scope).locators).toEqual([pause, revoke]);
});
