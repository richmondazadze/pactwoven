import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { createAuthorityCapsule, type MandateStopAction } from './mandate-authority';
import { assertAuthorityRecovery, authorityRecoveryKey, authorityWork, listAuthorityRecovery, locatorFromAuthorityCapsule, readAuthorityRecovery, storeAuthorityRecovery, type MandateAuthorityLocator } from './mandate-authority-recovery';
import { authorityRetryFlow, initialAuthorityRetry, lookupMandateAuthority, sendMandateAuthority, settleMandateAuthorityReceipt, type AuthorityLocalVerification, type AuthorityRetryFlow, type AuthorityTransportContext } from './mandate-authority-transport';
import { createMandateWorkCoordinator, type MandateWork } from './mandate-work-coordination';
import { decisionTestCase, mandateReadFixture, mandateFixtureNow as now } from './mandates.test-fixtures';
import type { MandateReadScope } from './mandates';
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const permit = (hash: string) => authorityRetryFlow(authorityRetryFlow(authorityRetryFlow(initialAuthorityRetry, { type: 'checked' }), { type: 'review', hash }), { type: 'retry' });
async function fixture(action: MandateStopAction = 'PAUSE') {
  const f = await mandateReadFixture(); f.page.head!.mandateEpoch = 7; f.page.eligibility = (['PAUSE', 'REVOKE'] as const).map(action => ({ action, eligible: true, requiresStepUp: false, blockers: [] }));
  const observation = { data: f.page, receivedAt: now, receivedMonotonic: 0 }, capsule = await createAuthorityCapsule(f.scope, observation, action, 'Stop new use. Existing obligations remain.', 'authority_original_key', now), locator = locatorFromAuthorityCapsule(capsule), store = storage();
  const result: MandateOperationResult = { schemaVersion: 1, organizationId: f.scope.organizationId, kind: locator.kind, responsibilityId: f.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(now + 1000).toISOString(), operation: { id: 'authority_operation', environment: f.scope.environment, status: 'succeeded', aggregateId: locator.mandate.id, aggregateVersion: 8, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
  let current: MandateReadScope | null = f.scope, selected: ReturnType<AuthorityTransportContext['selected']> = { integrityHash: capsule.integrityHash }; const recorded = new Map<string, MandateOperationResult>(), extra: MandateWork[] = [];
  const work = createMandateWorkCoordinator(() => { const inventory = listAuthorityRecovery(store, f.scope); return { blocked: inventory.blocked, records: [...inventory.locators.map(authorityWork), ...extra] }; }), controller = new AbortController();
  const context: AuthorityTransportContext = { current: () => current, getToken: vi.fn(async () => 'test_token'), signal: controller.signal, storage: () => store, work, selected: () => selected, recorded: value => recorded.get(authorityRecoveryKey(value)) ?? null, onRecorded: (value, result) => { recorded.set(authorityRecoveryKey(value), result); } };
  return { ...f, observation, capsule, locator, result, store, work, context, controller, extra, recorded, changeScope: (value: MandateReadScope | null) => { current = value; }, select: (value: ReturnType<AuthorityTransportContext['selected']>) => { selected = value; } };
}
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test'); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('authority exact dispatch, unknown originals and historical settlement', () => {
  it.each(['PAUSE', 'REVOKE'] as const)('persists %s before one exact POST without MFA or requester calls, then settles only its receipt', async action => {
    const f = await fixture(action), events: string[] = []; f.context.onPending = value => { expect(assertAuthorityRecovery(f.store, value)).toEqual(f.locator); events.push('pending'); };
    const fetcher = vi.fn(async () => { expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); events.push('fetch'); return json(f.result); }); vi.stubGlobal('fetch', fetcher);
    const result = await sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now }); expect(events).toEqual(['pending', 'fetch']); expect(fetcher).toHaveBeenCalledOnce(); expect(f.context.getToken).toHaveBeenCalledOnce();
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!; expect(url).toBe('https://api.example.test/v1/responsibilities/responsibility_a/mandates/mandate_a/authority'); expect(init.body).toBe(JSON.stringify(f.capsule.intent)); expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(f.capsule.key); expect(init.credentials).toBe('omit'); expect(init.cache).toBe('no-store');
    expect(f.context.recorded(f.locator)).toEqual(f.result); const receipt = await settleMandateAuthorityReceipt(f.locator, result, f.scope, f.context, f.capsule); expect(receipt.recordedState).toBe(action === 'PAUSE' ? 'PAUSED' : 'REVOKED'); expect(readAuthorityRecovery(f.store, f.locator).state).toBe('empty'); expect(fetcher).toHaveBeenCalledOnce(); expect(f.page.head!.state).toBe('ACTIVE');
  });
  it.each(['scope', 'session', 'role', 'site', 'selection', 'api', 'abort', 'expiry', 'ownership', 'storage', 'occupied'] as const)('blocks final-token %s change before POST', async change => {
    const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    f.context.getToken = async () => { queueMicrotask(() => queueMicrotask(() => { if (change === 'scope') f.changeScope({ ...f.scope, organizationEpoch: 4 }); if (change === 'session') f.changeScope({ ...f.scope, sessionId: 'new_session' }); if (change === 'role') f.changeScope({ ...f.scope, roles: ['operations'] }); if (change === 'site') f.changeScope({ ...f.scope, actionSiteIds: [] }); if (change === 'selection') f.select(null); if (change === 'api') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.example.test'); if (change === 'abort') f.controller.abort(); if (change === 'expiry') vi.advanceTimersByTime(60000); if (change === 'ownership') f.work.clear(); if (change === 'storage') f.store.setItem = () => { throw new Error('storage denied'); }; if (change === 'occupied') storeAuthorityRecovery(f.store, f.locator); })); return 'test_token'; };
    await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['scope', 'ownership', 'selection', 'stored-locator'] as const)('rechecks %s after synchronous persistence/pending publication without deleting the written original', async change => {
    const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); f.context.onPending = () => { if (change === 'scope') f.changeScope(null); if (change === 'ownership') f.work.clear(); if (change === 'selection') f.select(null); if (change === 'stored-locator') f.store.setItem(authorityRecoveryKey(f.locator), JSON.stringify({ ...f.locator, commandHash: 'a'.repeat(64) })); };
    await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(readAuthorityRecovery(f.store, f.locator).state).toBe('pending');
  });
  it('does not send when a storage adapter revokes ownership before its read-back', async () => {
    const f = await fixture(), write = f.store.setItem, fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); f.store.setItem = (key, value) => { write(key, value); f.work.clear(); }; await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('rejects caller input mutation during asynchronous validation', async () => { const f = await fixture(), capsule = structuredClone(f.capsule), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const task = sendMandateAuthority(capsule, f.context, { kind: 'first', now: Date.now }); capsule.intent.reason = 'Changed after click'; await expect(task).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it('keeps response loss and explicit 404 unresolved, then sends only an explicit identical same-key retry', async () => {
    const f = await fixture(), fetcher = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(f.result)); vi.stubGlobal('fetch', fetcher);
    await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); await expect(lookupMandateAuthority(f.locator, f.scope, f.context)).rejects.toMatchObject({ status: 404 }); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
    vi.advanceTimersByTime(3_600_001); await sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => permit(f.capsule.integrityHash) });
    const first = fetcher.mock.calls[0]![1] as RequestInit, retry = fetcher.mock.calls[2]![1] as RequestInit; expect(retry.body).toBe(first.body); expect((retry.headers as Record<string, string>)['Idempotency-Key']).toBe((first.headers as Record<string, string>)['Idempotency-Key']); expect((fetcher.mock.calls[1]![1] as RequestInit).method).toBe('GET');
  });
  it.each(['flow', 'selection', 'locator', 'scope', 'ownership'] as const)('rechecks retained retry %s at the last token handoff', async change => {
    const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); storeAuthorityRecovery(f.store, f.locator); let flow = permit(f.capsule.integrityHash);
    f.context.getToken = async () => { queueMicrotask(() => queueMicrotask(() => { if (change === 'flow') flow = initialAuthorityRetry; if (change === 'selection') f.select(null); if (change === 'locator') f.store.setItem(authorityRecoveryKey(f.locator), JSON.stringify({ ...f.locator, commandHash: 'a'.repeat(64) })); if (change === 'scope') f.changeScope(null); if (change === 'ownership') f.work.clear(); })); return 'test_token'; };
    await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => flow })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(readAuthorityRecovery(f.store, f.locator).state).toBe('pending');
  });
  it.each(['check', 'checked', 'reviewed'] as const)('cannot retry from phase %s', async phase => { const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); storeAuthorityRecovery(f.store, f.locator); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => ({ phase, reviewedHash: f.capsule.integrityHash }) })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it('requires explicit check then review then retry state transitions', () => { expect(authorityRetryFlow(initialAuthorityRetry, { type: 'review', hash: 'a' })).toEqual(initialAuthorityRetry); expect(authorityRetryFlow(initialAuthorityRetry, { type: 'retry' })).toEqual(initialAuthorityRetry); expect(permit('a')).toEqual({ phase: 'retrying', reviewedHash: 'a' }); expect(authorityRetryFlow(permit('a'), { type: 'checked' })).toEqual({ phase: 'checked', reviewedHash: null }); });
  it('recovers lost input with exact original-actor lookup and local receipt settlement, without a POST', async () => {
    const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); f.select(null); const fetcher = vi.fn(async () => json(f.result)); vi.stubGlobal('fetch', fetcher);
    const result = await lookupMandateAuthority(f.locator, f.scope, f.context); await settleMandateAuthorityReceipt(f.locator, result, f.scope, f.context); const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!; expect(url).toContain('/v1/mandate-operations?kind=mandate.pause&key=authority_original_key'); expect(init.method).toBe('GET'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('settles only the matching original kind/key when pause and revoke are both unknown', async () => {
    const f = await fixture(), revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'End accepted authority', f.capsule.key, now), other = locatorFromAuthorityCapsule(revoke); storeAuthorityRecovery(f.store, f.locator); storeAuthorityRecovery(f.store, other);
    await settleMandateAuthorityReceipt(f.locator, f.result, f.scope, f.context); expect(readAuthorityRecovery(f.store, f.locator).state).toBe('empty'); expect(assertAuthorityRecovery(f.store, other)).toEqual(other);
  });
  it('allows eligible revoke beside unknown pause but blocks a duplicate pause', async () => {
    const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); const duplicate = await createAuthorityCapsule(f.scope, f.observation, 'PAUSE', 'Stop duplicate', 'duplicate_pause_key', now); f.select({ integrityHash: duplicate.integrityHash }); const fetcher = vi.fn(async () => { throw new Error('lost'); }); vi.stubGlobal('fetch', fetcher);
    await expect(sendMandateAuthority(duplicate, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'End new use', 'separate_revoke_key', now); f.select({ integrityHash: revoke.integrityHash }); await expect(sendMandateAuthority(revoke, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce(); expect(listAuthorityRecovery(f.store, f.scope).locators).toHaveLength(2);
  });
  it('retains an old receipt after a newer observed head and changed current organization epoch', async () => {
    const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); const current = { ...f.scope, organizationEpoch: 4, sessionId: 'later_session' }; f.changeScope(current); f.page.head!.mandateEpoch = 12; f.page.head!.state = 'REVOKED'; const fetcher = vi.fn(async () => json(f.result)); vi.stubGlobal('fetch', fetcher);
    const result = await lookupMandateAuthority(f.locator, current, f.context); const receipt = await settleMandateAuthorityReceipt(f.locator, result, current, f.context); expect(receipt.recordedState).toBe('PAUSED'); expect(f.page.head!.mandateEpoch).toBe(12); expect(f.page.head!.state).toBe('REVOKED'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves verified receipt memory and the original when local removal fails, blocking all resends', async () => {
    const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); f.store.removeItem = () => {}; const onQualified = vi.fn(); f.context.onQualified = onQualified; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(settleMandateAuthorityReceipt(f.locator, f.result, f.scope, f.context)).rejects.toMatchObject({ code: 'AUTHORITY_STORAGE_UNAVAILABLE' }); expect(onQualified).toHaveBeenCalledOnce(); expect(f.context.recorded(f.locator)).toEqual(f.result); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
    await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => permit(f.capsule.integrityHash) })).rejects.toMatchObject({ code: 'AUTHORITY_ALREADY_RECORDED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['target', 'hash', 'foreign', 'pending'] as const)('does not settle an unqualified %s response', async change => {
    const f = await fixture(), result = structuredClone(f.result); if (change === 'target') { result.target.version++; result.operation.aggregateVersion++; } if (change === 'hash') result.target.hash = 'a'.repeat(64); if (change === 'foreign') result.organizationId = 'other_org'; if (change === 'pending') result.operation.status = 'pending'; vi.stubGlobal('fetch', vi.fn(async () => json(result)));
    if (change === 'pending') await sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now }); else await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); await expect(settleMandateAuthorityReceipt(f.locator, result, f.scope, f.context)).rejects.toThrow(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); expect(f.context.recorded(f.locator)).toBeNull();
  });
  it('retains the durable original after scope denial during the response', async () => { const f = await fixture(); vi.stubGlobal('fetch', vi.fn(async () => { f.changeScope(null); return json(f.result); })); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); expect(f.context.recorded(f.locator)).toBeNull(); });
  it('does not remove an original after a qualified callback changes scope', async () => { const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); f.context.onQualified = () => f.changeScope(null); await expect(settleMandateAuthorityReceipt(f.locator, f.result, f.scope, f.context)).rejects.toThrow(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); });
  it('blocks lost-input retry and foreign original-actor lookup', async () => { const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); storeAuthorityRecovery(f.store, f.locator); f.select(null); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => permit(f.capsule.integrityHash) })).rejects.toThrow(); const current = { ...f.scope, actorId: 'another_actor' }; f.changeScope(current); await expect(lookupMandateAuthority(f.locator, current, f.context)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it('supports lookup/settlement of a strictly stored future resume original without permitting a new resume send', async () => {
    const f = await fixture(), locator: MandateAuthorityLocator = { ...f.locator, kind: 'mandate.resume' }, result = { ...f.result, kind: 'mandate.resume' as const }; storeAuthorityRecovery(f.store, locator); const fetcher = vi.fn(async () => json(result)); vi.stubGlobal('fetch', fetcher);
    expect((await lookupMandateAuthority(locator, f.scope, f.context)).kind).toBe('mandate.resume'); expect((await settleMandateAuthorityReceipt(locator, result, f.scope, f.context)).recordedState).toBe('ACTIVE'); const input = structuredClone(f.capsule); Object.assign(input.intent, { action: 'RESUME' }); await expect(sendMandateAuthority(input, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('invalidates unsent grant ownership for an eligible stop while preserving dispatched and original grant work', async () => {
    const f = await fixture(), grantRequest = { scope: f.locator.scope, responsibilityId: f.scope.responsibilityId, targetId: 'proposal_a', key: 'grant_review_key', kind: 'AUTHORIZE' as const, action: 'send' as const }, grant = f.work.acquire(grantRequest); let resolve!: (value: Response) => void; const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r; })); vi.stubGlobal('fetch', fetcher);
    const task = sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now }); expect(() => f.work.assert(grant)).not.toThrow(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); expect(() => f.work.assert(grant)).toThrow(); resolve(json(f.result)); await task;
    const other = await fixture(), dispatched = other.work.acquire(grantRequest); other.work.markDispatched(dispatched); other.extra.push({ ...grantRequest, phase: 'pending' }); vi.stubGlobal('fetch', vi.fn(async () => json(other.result))); await sendMandateAuthority(other.capsule, other.context, { kind: 'first', now: Date.now }); expect(() => other.work.assert(dispatched)).not.toThrow(); expect(other.extra).toHaveLength(1);
  });
  it.each(['scope', 'locator', 'ownership'] as const)('blocks an original lookup when %s changes at the final token boundary', async change => {
    const f = await fixture(), fetcher = vi.fn(); storeAuthorityRecovery(f.store, f.locator); vi.stubGlobal('fetch', fetcher);
    f.context.getToken = async () => { queueMicrotask(() => queueMicrotask(() => { if (change === 'scope') f.changeScope(null); if (change === 'locator') f.store.setItem(authorityRecoveryKey(f.locator), JSON.stringify({ ...f.locator, intentHash: 'a'.repeat(64) })); if (change === 'ownership') f.work.clear(); })); return 'test_token'; };
    await expect(lookupMandateAuthority(f.locator, f.scope, f.context)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(readAuthorityRecovery(f.store, f.locator).state).toBe('pending');
  });
  it('blocks replacement controls beside an unknown revoke while preserving the original lookup', async () => {
    const f = await fixture('REVOKE'); storeAuthorityRecovery(f.store, f.locator); const pause = await createAuthorityCapsule(f.scope, f.observation, 'PAUSE', 'A new stop', 'new_pause_attempt', now); f.select({ integrityHash: pause.integrityHash }); const fetcher = vi.fn(async () => json(f.result)); vi.stubGlobal('fetch', fetcher);
    await expect(sendMandateAuthority(pause, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect((await lookupMandateAuthority(f.locator, f.scope, f.context)).kind).toBe('mandate.revoke'); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('blocks competing first-send calls after qualification and sends exactly once', async () => {
    const f = await fixture(), fetcher = vi.fn(async () => json(f.result)); vi.stubGlobal('fetch', fetcher); const results = await Promise.allSettled([sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now }), sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects a different retained original during receipt settlement without removing the locator', async () => {
    const f = await fixture(); storeAuthorityRecovery(f.store, f.locator); const other = await createAuthorityCapsule(f.scope, f.observation, 'PAUSE', 'Different original reason', 'other_authority_key', now); await expect(settleMandateAuthorityReceipt(f.locator, f.result, f.scope, f.context, other)).rejects.toThrow(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); expect(f.context.recorded(f.locator)).toBeNull();
  });
  it.each(['command-hash', 'target-hash', 'responsibility-hash', 'rebuilt-command-hash', 'rebuilt-target-hash', 'rebuilt-responsibility-hash'] as const)('preserves unsent grant ownership when full immutable verification rejects %s', async fault => {
    const f = await fixture(), grant = f.work.acquire({ scope: f.locator.scope, responsibilityId: f.scope.responsibilityId, targetId: 'proposal_a', key: 'grant_review_key', kind: 'AUTHORIZE', action: 'send' }), invalid = structuredClone(f.capsule), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    if (fault.endsWith('command-hash')) invalid.commandHash = '0'.repeat(64);
    if (fault.endsWith('target-hash')) invalid.expectedTarget.hash = '0'.repeat(64);
    if (fault.endsWith('responsibility-hash') && !('envelope' in invalid.observation.data)) invalid.observation.data.responsibilityReference.hash = '0'.repeat(64);
    // Re-sign the capsule wrapper in these cases to exercise semantic record/digest
    // qualification beyond rejection of the outer integrity hash alone.
    if (fault.startsWith('rebuilt-')) { const { integrityHash: _, ...body } = invalid; invalid.integrityHash = await commandDigest(body); f.select({ integrityHash: invalid.integrityHash }); }
    await expect(sendMandateAuthority(invalid, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(f.work.state(grant)).toBe('unsent'); expect(() => f.work.assert(grant)).not.toThrow(); expect(f.context.getToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(f.store.length).toBe(0);
  });
  it.each(['scope', 'selection', 'expiry', 'storage', 'new-original', 'unknown-revoke', 'input'] as const)('rechecks %s after immutable qualification without invalidating an unsent grant', async change => {
    const f = await fixture(), grant = f.work.acquire({ scope: f.locator.scope, responsibilityId: f.scope.responsibilityId, targetId: 'proposal_a', key: 'grant_review_key', kind: 'AUTHORIZE', action: 'send' }), input = structuredClone(f.capsule), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const task = sendMandateAuthority(input, f.context, { kind: 'first', now: Date.now });
    if (change === 'scope') f.changeScope(null); if (change === 'selection') f.select(null); if (change === 'expiry') vi.advanceTimersByTime(60_000); if (change === 'storage') f.store.setItem('pactwoven:mandate-authority:v1:corrupt', 'unreadable'); if (change === 'new-original') storeAuthorityRecovery(f.store, f.locator); if (change === 'unknown-revoke') storeAuthorityRecovery(f.store, { ...f.locator, kind: 'mandate.revoke' }); if (change === 'input') input.intent.reason = 'Changed while hashing';
    await expect(task).rejects.toThrow(); expect(f.work.state(grant)).toBe('unsent'); expect(fetcher).not.toHaveBeenCalled(); expect(f.context.getToken).not.toHaveBeenCalled(); if (change === 'new-original') expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('rejects cleared coordinator ownership after preliminary verification with zero token, storage or network effects', async () => {
    const f = await fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const task = sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now }); f.work.clear(); await expect(task).rejects.toThrow(); expect(f.context.getToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(f.store.length).toBe(0);
  });
  it('does not invalidate unsent grant ownership for an already ineligible stop', async () => { const f = await fixture(), grant = f.work.acquire({ scope: f.locator.scope, responsibilityId: f.scope.responsibilityId, targetId: 'proposal_a', key: 'grant_review_key', kind: 'AUTHORIZE', action: 'send' }); vi.advanceTimersByTime(60_000); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'first', now: Date.now })).rejects.toThrow(); expect(() => f.work.assert(grant)).not.toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
});

async function resumeFixture() {
  const base = await fixture(), approved = await decisionTestCase('AUTHORIZE'), review = structuredClone(approved.outcomeReview), at = now + 2000;
  vi.setSystemTime(at); review.envelope.head!.state = 'PAUSED'; review.envelope.head!.mandateEpoch = 2; review.envelope.observedAt = new Date(at).toISOString();
  review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; review.envelope.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
  const observation = { data: review, receivedAt: at, receivedMonotonic: 0 }, capsule = await createAuthorityCapsule(base.scope, observation, 'RESUME', 'Resume exactly the accepted terms.', 'resume_original_key', at), locator = locatorFromAuthorityCapsule(capsule);
  base.select({ integrityHash: capsule.integrityHash });
  const result: MandateOperationResult = { ...base.result, kind: 'mandate.resume', target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, operation: { ...base.result.operation, aggregateVersion: locator.expectedTarget.version } };
  let generation = 0, verification: AuthorityLocalVerification | null = { integrityHash: capsule.integrityHash, generation, verifiedAt: at }, currentObservation: typeof observation | null = observation;
  const grant = base.work.registerPreparation({ ...authorityWork(locator), kind: 'RESUME', integrityHash: capsule.integrityHash }, base.work.generation(locator.scope, locator.responsibilityId));
  const resume = { preparation: grant, currentGeneration: () => generation, currentVerification: () => verification, currentObservation: () => currentObservation };
  return { ...base, observation, capsule, locator, result, grant, resume, permission: { kind: 'first' as const, now: Date.now, resume }, setGeneration: (value: number) => { generation = value; }, setVerification: (value: AuthorityLocalVerification | null) => { verification = value; }, setObservation: (value: typeof observation | null) => { currentObservation = value; } };
}
function resumeRetry(f: Awaited<ReturnType<typeof resumeFixture>>) {
  const reviewed = authorityRetryFlow(authorityRetryFlow(initialAuthorityRetry, { type: 'checked' }), { type: 'review', hash: f.capsule.integrityHash });
  return authorityRetryFlow(authorityRetryFlow(reviewed, { type: 'verified', verification: f.resume.currentVerification()! }), { type: 'retry', action: 'RESUME', now: Date.now() });
}
describe('resume exact grant and retained-original permission', () => {
  it('binds the exact preparation to its single internal ticket before token retrieval and sends once', async () => {
    const f = await resumeFixture(), bind = vi.spyOn(f.work, 'bindPreparation'), fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); expect(f.work.preparationCurrent(f.grant)).toBe(false);
      expect(init.body).toBe(JSON.stringify(f.capsule.intent)); expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(f.capsule.key); return json(f.result);
    }); vi.stubGlobal('fetch', fetcher);
    f.context.getToken = async () => { expect(bind).toHaveBeenCalledOnce(); expect(bind.mock.calls[0]![0]).toBe(f.grant); expect(f.work.preparationCurrent(f.grant)).toBe(true); return 'test_token'; };
    const result = await sendMandateAuthority(f.capsule, f.context, f.permission); expect(fetcher).toHaveBeenCalledOnce();
    expect((await settleMandateAuthorityReceipt(f.locator, result, f.scope, f.context, f.capsule)).recordedState).toBe('ACTIVE'); expect(f.observation.data.envelope.head!.state).toBe('PAUSED'); expect(f.store.length).toBe(0);
  });
  it.each(['missing-permission', 'missing-factors', 'wrong-review', 'future-factors', 'expired-factors', 'old-generation', 'released-grant', 'wrong-grant', 'changed-observation'] as const)('rejects %s first resume with no token, persistence or POST', async change => {
    const f = await resumeFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); let permission = f.permission;
    if (change === 'missing-permission') permission = { kind: 'first', now: Date.now } as typeof permission;
    if (change === 'missing-factors') f.setVerification(null); if (change === 'wrong-review') f.setVerification({ ...f.resume.currentVerification()!, integrityHash: 'a'.repeat(64) });
    if (change === 'future-factors') f.setVerification({ ...f.resume.currentVerification()!, verifiedAt: Date.now() + 1 }); if (change === 'expired-factors') f.setVerification({ ...f.resume.currentVerification()!, verifiedAt: Date.now() - 240_000 });
    if (change === 'old-generation') f.setGeneration(1); if (change === 'released-grant') f.work.releasePreparation(f.grant);
    if (change === 'wrong-grant') { f.work.releasePreparation(f.grant); permission = { ...f.permission, resume: { ...f.resume, preparation: f.work.registerPreparation({ ...authorityWork(f.locator), kind: 'RESUME', key: 'other_original_key', integrityHash: f.capsule.integrityHash }, 0) } }; }
    if (change === 'changed-observation') f.setObservation(null);
    await expect(sendMandateAuthority(f.capsule, f.context, permission)).rejects.toThrow(); expect(f.context.getToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(f.store.length).toBe(0);
  });
  it.each(['factors', 'replacement-factors', 'generation', 'observation', 'expiry', 'stop'] as const)('rechecks %s at token completion with zero dispatch', async change => {
    const f = await resumeFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    if (change === 'expiry') f.setVerification({ ...f.resume.currentVerification()!, verifiedAt: Date.now() - 239_999 });
    f.context.getToken = async () => {
      if (change === 'factors') f.setVerification(null); if (change === 'generation') f.setGeneration(1); if (change === 'observation') f.setObservation(null); if (change === 'expiry') vi.advanceTimersByTime(2);
      if (change === 'replacement-factors') f.setVerification({ ...f.resume.currentVerification()!, verifiedAt: Date.now() - 1 });
      if (change === 'stop') { const stop = f.work.acquire({ ...authorityWork(f.locator), kind: 'REVOKE', key: 'separate_stop_key', action: 'send', eligible: true, hasHead: true }); f.work.release(stop); }
      return 'test_token';
    };
    await expect(sendMandateAuthority(f.capsule, f.context, f.permission)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(f.store.length).toBe(0);
  });
  it.each(['factors', 'generation', 'observation', 'stop'] as const)('rechecks %s after locator publication and keeps the unsent original if rejected', async change => {
    const f = await resumeFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    f.context.onPending = () => {
      if (change === 'factors') f.setVerification(null); if (change === 'generation') f.setGeneration(1); if (change === 'observation') f.setObservation(null);
      if (change === 'stop') { const stop = f.work.acquire({ ...authorityWork(f.locator), kind: 'REVOKE', key: 'published_stop_key', action: 'send', eligible: true, hasHead: true }); f.work.release(stop); }
    };
    await expect(sendMandateAuthority(f.capsule, f.context, f.permission)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('rejects a preparation invalidated while immutable capsule verification is in progress', async () => {
    const f = await resumeFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const task = sendMandateAuthority(f.capsule, f.context, f.permission);
    const stop = f.work.acquire({ ...authorityWork(f.locator), kind: 'REVOKE', key: 'hashing_stop_key', action: 'send', eligible: true, hasHead: true }); f.work.release(stop);
    await expect(task).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(f.context.getToken).not.toHaveBeenCalled(); expect(f.store.length).toBe(0);
  });
  it('preserves an already dispatched resume and its receipt when a later stop advances generation', async () => {
    const f = await resumeFixture(), fetcher = vi.fn(async () => {
      const stop = f.work.acquire({ ...authorityWork(f.locator), kind: 'REVOKE', key: 'after_dispatch_stop', action: 'send', eligible: true, hasHead: true }); f.work.release(stop); f.setGeneration(1); return json(f.result);
    }); vi.stubGlobal('fetch', fetcher);
    expect((await sendMandateAuthority(f.capsule, f.context, f.permission)).kind).toBe('mandate.resume'); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('requires checked, reviewed and freshly verified resume retry without changing stop transitions', () => {
    const hash = 'a'.repeat(64), reviewed = authorityRetryFlow(authorityRetryFlow(initialAuthorityRetry, { type: 'checked' }), { type: 'review', hash });
    expect(authorityRetryFlow(reviewed, { type: 'retry', action: 'RESUME', now })).toEqual(reviewed);
    const verified = authorityRetryFlow(reviewed, { type: 'verified', verification: { integrityHash: hash, generation: 2, verifiedAt: now } });
    expect(authorityRetryFlow(verified, { type: 'retry', action: 'RESUME', now: now + 240_000 })).toEqual(verified);
    expect(authorityRetryFlow(verified, { type: 'retry', action: 'RESUME', now })).toMatchObject({ phase: 'retrying', verification: { generation: 2 } });
    expect(authorityRetryFlow(verified, { type: 'invalidate' })).toEqual(reviewed); expect(authorityRetryFlow(reviewed, { type: 'retry' })).toEqual({ phase: 'retrying', reviewedHash: hash });
  });
  it('retries the exact retained resume after later head/observation/terms expiry using fresh factors, without a new grant registration', async () => {
    const f = await resumeFixture(); f.work.releasePreparation(f.grant); storeAuthorityRecovery(f.store, f.locator); f.extra.push({ ...authorityWork(f.locator), kind: 'REVOKE', key: 'later_revoke_key' });
    vi.advanceTimersByTime(3_600_001); f.setGeneration(4); f.setVerification({ integrityHash: f.capsule.integrityHash, generation: 4, verifiedAt: Date.now() }); f.setObservation(null);
    const flow = resumeRetry(f), fetcher = vi.fn(async (_url: string, init: RequestInit) => { expect(init.body).toBe(JSON.stringify(f.capsule.intent)); expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(f.capsule.key); return json(f.result); }); vi.stubGlobal('fetch', fetcher);
    await sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => flow, resume: f.resume }); expect(fetcher).toHaveBeenCalledOnce(); expect(f.work.preparationCurrent(f.grant)).toBe(false);
  });
  it.each(['missing-verification', 'wrong-flow-verification', 'old-generation', 'missing-original-review'] as const)('rejects %s retained retry without a POST', async change => {
    const f = await resumeFixture(); f.work.releasePreparation(f.grant); storeAuthorityRecovery(f.store, f.locator); let flow = resumeRetry(f);
    if (change === 'missing-verification') f.setVerification(null); if (change === 'wrong-flow-verification') flow = { ...flow, verification: { ...flow.verification!, generation: 3 } }; if (change === 'old-generation') f.setGeneration(1); if (change === 'missing-original-review') f.select(null);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => flow, resume: f.resume })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('rejects late retry factor renewal after the separate retry click without rebinding to a newer round', async () => {
    const f = await resumeFixture(); f.work.releasePreparation(f.grant); storeAuthorityRecovery(f.store, f.locator); let flow = resumeRetry(f);
    f.context.getToken = async () => { f.setGeneration(1); f.setVerification({ integrityHash: f.capsule.integrityHash, generation: 1, verifiedAt: Date.now() }); flow = resumeRetry(f); return 'test_token'; };
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await expect(sendMandateAuthority(f.capsule, f.context, { kind: 'retry', currentFlow: () => flow, resume: f.resume })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' }); expect(fetcher).not.toHaveBeenCalled(); expect(assertAuthorityRecovery(f.store, f.locator)).toEqual(f.locator);
  });
  it('looks up and settles a resume with lost private input and no factor state using only GET', async () => {
    const f = await resumeFixture(); f.work.releasePreparation(f.grant); storeAuthorityRecovery(f.store, f.locator); f.select(null); f.setVerification(null);
    const fetcher = vi.fn(async () => json(f.result)); vi.stubGlobal('fetch', fetcher); const result = await lookupMandateAuthority(f.locator, f.scope, f.context);
    expect((await settleMandateAuthorityReceipt(f.locator, result, f.scope, f.context)).recordedState).toBe('ACTIVE'); expect(fetcher).toHaveBeenCalledOnce(); expect((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].method).toBe('GET'); expect(f.store.length).toBe(0);
  });
  it.each(['mandate.pause', 'mandate.revoke', 'mandate.resume'] as const)('preserves a competing same-key %s original instead of excluding the wrong kind', async kind => {
    const f = await resumeFixture(), original = { ...f.locator, kind }; storeAuthorityRecovery(f.store, original);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await expect(sendMandateAuthority(f.capsule, f.context, f.permission)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(f.context.getToken).not.toHaveBeenCalled(); expect(listAuthorityRecovery(f.store, f.scope).locators).toEqual([original]);
  });
});
