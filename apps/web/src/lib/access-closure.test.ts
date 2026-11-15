import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSchema, type AccessRecoveryResult, type Operation } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { ACCESS_CLOSURE_FACTOR_MS, ACCESS_CLOSURE_OBSERVATION_MS, accessCloseFlow, accessClosureScope, accessClosureTime, accessRecoveryPath, checkAccessRecovery, closeAccessRecovery, closureObservationCurrent, closureVerificationCurrent, initialAccessCloseFlow, prepareAccessClosure, qualifyAccessRecoveryResult, verifyAccessCloseReview, type AccessCloseReview, type AccessClosureContext, type AccessClosureObservation } from './access-closure';
import { accessRecoveryStored, readAccessRecovery, saveAccessRecovery, type AccessRecovery } from './access-recovery';
import { RequestError } from './api';
import type { RetryContext } from './access-retry';
const now = Date.parse('2026-11-15T12:00:00.000Z');
const session = SessionSchema.parse({ actor: { actorId: 'actor_owner', principalKind: 'human', organizationId: 'internal_org', environment: 'development', roles: ['owner'], siteIds: ['site_one'], actionSiteIds: ['site_one'], sessionId: 'api_session', authenticatedAt: '2026-11-15T00:00:00Z', correlationId: 'test_correlation' }, organization: { id: 'internal_org', name: 'Organization', authorityEpoch: 8 }, sites: [{ id: 'site_one', name: 'Site', timeZone: 'UTC' }] });
const base: RetryContext = { session, auth: { userId: 'provider_user', orgId: 'provider_org', sessionId: 'provider_session' }, apiBase: 'https://api.example.test' };
const locator: AccessRecovery = { version: 2, key: 'Original_Key-123456789', kind: 'grant', userId: 'provider_user', organizationId: 'provider_org', apiBase: base.apiBase!, internalOrganizationId: 'internal_org', actorId: 'actor_owner', environment: 'development' };
const legacy: AccessRecovery = { version: 1, key: locator.key, kind: locator.kind, userId: locator.userId, organizationId: locator.organizationId, apiBase: locator.apiBase };
const operation: Operation = { id: 'operation_one', environment: 'development', status: 'succeeded', aggregateId: 'original_target', aggregateVersion: 4, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null };
function result(kind: AccessRecovery['kind'] = 'grant', disposition: AccessRecoveryResult['disposition'] = 'not_recorded'): AccessRecoveryResult {
  const common = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'internal_org', externalOrganizationId: 'provider_org', kind, key: locator.key, observedAt: new Date(now).toISOString(), reviewer: { actorId: 'actor_owner', externalMembershipId: 'current_membership', authorityEpoch: 9 } };
  return disposition === 'fenced' ? { ...common, disposition, fence: { id: 'fence_one', closedAt: new Date(now - 1).toISOString() } } : disposition === 'recorded' ? { ...common, disposition, operation } : { ...common, disposition };
}
function observation(selected: AccessRecovery = locator, value = result(selected.kind)): AccessClosureObservation { return { result: value, scope: accessClosureScope(base), receivedAt: now, receivedMonotonic: performance.now(), sessionAuthorityEpoch: 8 }; }
function context(selected: AccessRecovery = locator): AccessClosureContext { return { current: () => base, selected: () => selected, hasOriginal: () => false, getToken: async () => 'current_token', signal: new AbortController().signal }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function transport(value: unknown = result('grant', 'fenced')) { const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json(value)); vi.stubGlobal('fetch', fetcher); return fetcher; }
const posts = (fetcher: ReturnType<typeof transport>) => fetcher.mock.calls.filter(call => call[1]?.method === 'POST');
async function review(selected = locator) { return prepareAccessClosure(observation(selected), selected, base, false); }
function verified(value: AccessCloseReview) { return accessCloseFlow(accessCloseFlow(accessCloseFlow(initialAccessCloseFlow, { type: 'checked' }), { type: 'review', hash: value.integrityHash }), { type: 'verified', at: Date.now() }); }
function permitted(value: AccessCloseReview) { return accessCloseFlow(verified(value), { type: 'close', now: Date.now() }); }
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base.apiBase!); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('typed original-key observation and current administrative review', () => {
  it.each(['grant', 'revise', 'revoke'] as const)('uses the short %s namespace and exact key with a read-only typed GET', async kind => {
    const selected = { ...locator, kind }, fetcher = transport(result(kind));
    const checked = await checkAccessRecovery(selected, context(selected));
    expect(checked.result.disposition).toBe('not_recorded'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toMatchObject([`${base.apiBase}/v1/member-access/recovery?kind=${kind}&key=Original_Key-123456789`, { method: 'GET', cache: 'no-store', credentials: 'omit' }]);
    expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined(); expect(Object.isFrozen(checked.result.reviewer)).toBe(true);
  });
  it('does not treat 404, unavailable transport or malformed typed data as absence', async () => {
    for (const status of [404, 503]) { const fetcher = vi.fn(async () => json({}, status)); vi.stubGlobal('fetch', fetcher); await expect(checkAccessRecovery(locator, context())).rejects.toMatchObject({ status }); expect(fetcher).toHaveBeenCalledTimes(1); }
    for (const value of [null, operation, { ...result(), operation }, { ...result(), disposition: 'missing' }]) { transport(value); await expect(checkAccessRecovery(locator, context())).rejects.toMatchObject({ code: 'RESPONSE_UNVERIFIED' }); }
  });
  it('qualifies all current response affinity and rejects mixed, wrong namespace or financial facts', () => {
    const scope = accessClosureScope(base);
    for (const changed of [{ environment: 'staging' }, { organizationId: 'other_org' }, { externalOrganizationId: 'other_provider' }, { reviewer: { ...result().reviewer, actorId: 'other_actor' } }, { kind: 'revise' }, { key: 'other_key_123456789' }, { kind: 'member.grant' }, { kind: 'mandate.authorize' }, { fence: { id: 'extra', closedAt: new Date(now).toISOString() } }]) expect(() => qualifyAccessRecoveryResult({ ...result(), ...changed }, locator, scope)).toThrow();
    for (const changed of [{ environment: 'staging' }, { financialState: 'FINALIZED' }]) expect(() => qualifyAccessRecoveryResult({ ...result('grant', 'recorded'), operation: { ...operation, ...changed } }, locator, scope)).toThrow();
    expect(() => accessRecoveryPath({ ...locator, kind: 'member.grant' } as unknown as AccessRecovery)).toThrow();
  });
  it('preserves v1 as a provider-scoped locator and uses only current response pins for its new review', async () => {
    const value = await review(legacy);
    expect(value.locator).toEqual(legacy); expect(Object.keys(value.locator)).not.toContain('actorId');
    expect(value.scope.organizationId).toBe('internal_org'); expect(value.intent.expectedExternalMembershipId).toBe('current_membership'); expect(value.intent.expectedAuthorityEpoch).toBe(9);
    expect(value.sessionAuthorityEpoch).toBe(8); expect(canonicalJson(legacy)).not.toContain('internal_org');
    for (const changed of [{ userId: 'other' }, { organizationId: 'other' }, { apiBase: 'https://other.example.test' }]) await expect(prepareAccessClosure(observation(), { ...legacy, ...changed }, base, false)).rejects.toThrow();
  });
  it('requires every v2 scope pin and a current human owner', async () => {
    for (const changed of [{ environment: 'staging' as const }, { internalOrganizationId: 'other' }, { actorId: 'other' }]) await expect(prepareAccessClosure(observation(), { ...locator, ...changed }, base, false)).rejects.toMatchObject({ code: 'RECOVERY_SCOPE_CHANGED' });
    for (const actor of [{ ...session.actor, principalKind: 'service' as const }, { ...session.actor, roles: ['finance' as const] }, { ...session.actor, organizationId: 'other' }]) expect(() => accessClosureScope({ ...base, session: { ...session, actor } })).toThrow();
  });
  it('requires missing original input and typed not_recorded, including for corrupt/foreign retained input', async () => {
    await expect(prepareAccessClosure(observation(), locator, base, true)).rejects.toMatchObject({ code: 'ORIGINAL_INPUT_AVAILABLE' });
    for (const disposition of ['recorded', 'fenced'] as const) await expect(prepareAccessClosure(observation(locator, result('grant', disposition)), locator, base, false)).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' });
    await expect(prepareAccessClosure(observation(), locator, { ...base, session: { ...session, organization: { ...session.organization, authorityEpoch: 9 } } }, false)).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' });
  });
  it('clones/freezes only the administrative intent and detects changed review/key/scope/body without inventing command input', async () => {
    const selected = { ...locator }, observed = observation(selected), pending = prepareAccessClosure(observed, selected, base, false); selected.key = 'changed_during_digest';
    const value = await pending; expect(value.locator).toEqual(locator); expect(Object.isFrozen(value.intent)).toBe(true); expect(Object.isFrozen(value.scope.roles)).toBe(true);
    expect(value.intent).toEqual({ schemaVersion: 1, kind: 'grant', reason: 'original_input_unavailable', expectedEnvironment: 'development', expectedOrganizationId: 'internal_org', expectedActorId: 'actor_owner', expectedExternalMembershipId: 'current_membership', expectedAuthorityEpoch: 9 });
    for (const extra of [{ locator: { ...value.locator, key: 'changed_key_123456789' } }, { intent: { ...value.intent, expectedAuthorityEpoch: 10 } }, { scope: { ...value.scope, sessionId: 'changed' } }, { integrityHash: '0'.repeat(64) }, { proof: 'invented' }]) await expect(verifyAccessCloseReview({ ...value, ...extra } as AccessCloseReview)).rejects.toThrow();
    for (const forbidden of ['targetActorId', 'commandHash', 'originalCommand', 'password', 'totp', 'evidenceRefs']) expect(JSON.stringify(value.intent)).not.toContain(forbidden);
  });
  it('pins the 60-second observation and 240-second factor guards and resists a wall-clock rollback for observation', async () => {
    expect(ACCESS_CLOSURE_OBSERVATION_MS).toBe(60_000); expect(ACCESS_CLOSURE_FACTOR_MS).toBe(240_000);
    expect(closureObservationCurrent(new Date(now).toISOString(), now + 59_999)).toBe(true); expect(closureObservationCurrent(new Date(now).toISOString(), now + 60_000)).toBe(false); expect(closureObservationCurrent(new Date(now).toISOString(), now - 1)).toBe(false);
    expect(closureVerificationCurrent(now, now + 239_999)).toBe(true); expect(closureVerificationCurrent(now, now + 240_000)).toBe(false); expect(closureVerificationCurrent(now, now - 1)).toBe(false); expect(closureVerificationCurrent(null, now)).toBe(false);
    expect(accessClosureTime({ observedAt: new Date(now).toISOString(), receivedAt: now, receivedMonotonic: 10 }, now - 10_000, 60_010)).toBe(now + 60_000);
    vi.setSystemTime(now + 60_000); await expect(review()).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' });
  });
});

describe('explicit administrative close transport', () => {
  it('requires separate check/review/verification/close transitions; verification alone never POSTs', async () => {
    const value = await review(), fetcher = transport(), initial = initialAccessCloseFlow;
    expect(accessCloseFlow(initial, { type: 'verified', at: now })).toEqual(initial); expect(accessCloseFlow(initial, { type: 'close', now })).toEqual(initial);
    const ready = verified(value); expect(ready.phase).toBe('verified'); await expect(closeAccessRecovery(value, ready, context(), vi.fn())).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' }); expect(fetcher).not.toHaveBeenCalled();
    expect(accessCloseFlow(ready, { type: 'invalidate' })).toMatchObject({ phase: 'reviewed', verifiedAt: null }); expect(accessCloseFlow(ready, { type: 'close', now: now + 240_000 })).toEqual(ready);
  });
  it.each(['grant', 'revise', 'revoke'] as const)('sends %s once with the original key header and exact frozen close body', async kind => {
    const selected = { ...locator, kind }, value = await review(selected), expected = result(kind, 'fenced'), fetcher = transport(expected), dispatched = vi.fn(), token = vi.fn(async () => 'fresh_bearer');
    expect(await closeAccessRecovery(value, permitted(value), { ...context(selected), getToken: token }, dispatched)).toEqual(expected);
    expect(token).toHaveBeenCalledTimes(1); expect(dispatched).toHaveBeenCalledTimes(1); expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]).toMatchObject([base.apiBase + '/v1/member-access/recovery/close', { method: 'POST', headers: { Authorization: 'Bearer fresh_bearer', 'Idempotency-Key': selected.key }, body: JSON.stringify(value.intent) }]);
    expect(Object.keys(JSON.parse(String(posts(fetcher)[0]![1]?.body)))).toEqual(Object.keys(value.intent));
  });
  it('prevents POST when scope, original input, selected locator, API, epoch, expiry or abort changes during token retrieval', async () => {
    const value = await review();
    const changes: ((state: { current: RetryContext; selected: AccessRecovery | null; original: boolean; controller: AbortController }) => void)[] = [
      s => { s.current = { ...base, auth: { ...base.auth, userId: 'other' } }; }, s => { s.current = { ...base, auth: { ...base.auth, orgId: 'other' } }; }, s => { s.current = { ...base, auth: { ...base.auth, sessionId: 'other' } }; },
      s => { s.current = { ...base, session: { ...session, actor: { ...session.actor, roles: ['finance'] } } }; }, s => { s.current = { ...base, session: { ...session, actor: { ...session.actor, siteIds: [] } } }; }, s => { s.current = { ...base, session: { ...session, actor: { ...session.actor, actionSiteIds: [] } } }; },
      s => { s.current = { ...base, session: { ...session, organization: { ...session.organization, authorityEpoch: 10 } } }; }, s => { s.current = { ...base, apiBase: 'https://changed.example.test' }; },
      s => { s.selected = null; }, s => { s.selected = { ...locator, key: 'other_key_123456789' }; }, s => { s.original = true; }, s => { s.controller.abort(); }, () => { vi.setSystemTime(now + 60_000); }, () => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://changed.example.test'); },
    ];
    for (const change of changes) {
      vi.setSystemTime(now); vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base.apiBase!); const state = { current: base, selected: locator as AccessRecovery | null, original: false, controller: new AbortController() }, fetcher = transport(), dispatched = vi.fn();
      await expect(closeAccessRecovery(value, permitted(value), { current: () => state.current, selected: () => state.selected, hasOriginal: () => state.original, signal: state.controller.signal, getToken: async () => { await Promise.resolve(); change(state); return 'token'; } }, dispatched)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled();
    }
  });
  it('prevents POST for missing tokens, expired factors, changed review hash and a failed exact-storage dispatch guard', async () => {
    const value = await review(), fetcher = transport();
    await expect(closeAccessRecovery(value, permitted(value), { ...context(), getToken: async () => null }, vi.fn())).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    await expect(closeAccessRecovery(value, { ...permitted(value), verifiedAt: now - 240_000 }, context(), vi.fn())).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(closeAccessRecovery(value, { ...permitted(value), reviewedHash: 'different' }, context(), vi.fn())).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' });
    await expect(closeAccessRecovery(value, permitted(value), context(), () => { throw new Error('Stored locator replaced'); })).rejects.toThrow('Stored locator replaced'); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['recorded', 'fenced'] as const)('accepts a committed %s fact after dispatch even if observation/factors expire or reviewer/session epoch advances', async disposition => {
    const value = await review(); let current = base; const returned = { ...result('grant', disposition), reviewer: { ...result().reviewer, authorityEpoch: 12 } };
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => { current = { ...base, session: { ...session, organization: { ...session.organization, authorityEpoch: 12 } } }; vi.setSystemTime(now + 300_000); return json(returned); }); vi.stubGlobal('fetch', fetcher);
    expect(await closeAccessRecovery(value, permitted(value), { ...context(), current: () => current }, vi.fn())).toEqual(returned); expect(posts(fetcher)).toHaveLength(1);
  });
  it('does not accept another current reviewer membership, unrelated response, close absence or nonfinancial corruption', async () => {
    const value = await review();
    for (const returned of [result(), { ...result('grant', 'fenced'), reviewer: { ...result().reviewer, externalMembershipId: 'replacement_member' } }, { ...result('grant', 'fenced'), key: 'foreign_key_123456789' }, { ...result('grant', 'recorded'), operation: { ...operation, financialState: 'FINALIZED' } }]) { transport(returned); await expect(closeAccessRecovery(value, permitted(value), context(), vi.fn())).rejects.toThrow(); }
  });
  it('returns recorded nonterminal as unresolved data without fabricating a fence or terminal operation', async () => {
    const value = await review(); for (const status of ['accepted', 'pending', 'unknown'] as const) { const returned = { ...result('grant', 'recorded'), operation: { ...operation, status } }; transport(returned); expect(await closeAccessRecovery(value, permitted(value), context(), vi.fn())).toEqual(returned); await expect(prepareAccessClosure(observation(locator, returned), locator, base, false)).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' }); }
  });
  it('never resends after response loss; a later explicit GET can resolve the permanent fact without another POST', async () => {
    const value = await review(), before = canonicalJson(value); const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => { if (init?.method === 'POST') throw new TypeError('Response lost'); return json(result('grant', 'fenced')); }); vi.stubGlobal('fetch', fetcher);
    await expect(closeAccessRecovery(value, permitted(value), context(), vi.fn())).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' }); expect(posts(fetcher)).toHaveLength(1); expect(canonicalJson(value)).toBe(before);
    expect((await checkAccessRecovery(locator, context())).result.disposition).toBe('fenced'); expect(posts(fetcher)).toHaveLength(1);
  });
  it('permits a newly explicit administrative review with current epoch under the unchanged original namespace', async () => {
    const current = { ...base, session: { ...session, organization: { ...session.organization, authorityEpoch: 10 } } }, observed = { ...observation(), sessionAuthorityEpoch: 10, result: { ...result(), reviewer: { ...result().reviewer, authorityEpoch: 10 } } };
    const value = await prepareAccessClosure(observed, locator, current, false); expect(value.intent.expectedAuthorityEpoch).toBe(10); expect(value.locator).toEqual(locator);
    transport({ ...result('grant', 'fenced'), reviewer: { ...result().reviewer, authorityEpoch: 10 } }); await expect(closeAccessRecovery(value, permitted(value), { ...context(), current: () => current }, vi.fn())).resolves.toMatchObject({ disposition: 'fenced' });
  });
  it('rejects stale async GET/POST completions after scope loss and leaves all persistence outside transport', async () => {
    const value = await review(); let current = base; const fetcher = vi.fn(async () => { current = { ...base, auth: { ...base.auth, sessionId: 'new_session' } }; return json(result('grant', 'fenced')); }); vi.stubGlobal('fetch', fetcher);
    await expect(closeAccessRecovery(value, permitted(value), { ...context(), current: () => current }, vi.fn())).rejects.toMatchObject({ code: 'RECOVERY_SCOPE_CHANGED' }); current = base;
    await expect(checkAccessRecovery(locator, { ...context(), current: () => current })).rejects.toMatchObject({ code: 'RECOVERY_SCOPE_CHANGED' });
  });
});


describe('B3-R1 final synchronous closure preflight', () => {
  it.each(['selected-reference', 'epoch', 'owner-role', 'retained-input', 'session', 'read-site', 'action-site', 'api', 'observation-expiry', 'factor-expiry', 'flow-phase'] as const)('prevents POST when %s changes in the final token-wrapper handoff', async change => {
    const value = await review(), permission = permitted(value), fetcher = transport(), dispatched = vi.fn();
    let current = structuredClone(base), selected = structuredClone(locator), original = false, changed = false;
    if (change === 'factor-expiry') permission.verifiedAt = now - ACCESS_CLOSURE_FACTOR_MS + 1;
    const token = vi.fn(async () => {
      // The second microtask runs after the closure token wrapper's last early
      // check, but before apiRequest resumes its await. This is the reviewed R1 race.
      queueMicrotask(() => queueMicrotask(() => {
        changed = true;
        if (change === 'selected-reference') selected = { ...selected, key: 'replacement_key_123456789' };
        if (change === 'epoch') current = { ...current, session: { ...current.session, organization: { ...current.session.organization, authorityEpoch: 10 } } };
        if (change === 'owner-role') current = { ...current, session: { ...current.session, actor: { ...current.session.actor, roles: ['finance'] } } };
        if (change === 'retained-input') original = true;
        if (change === 'session') current = { ...current, auth: { ...current.auth, sessionId: 'other_session' } };
        if (change === 'read-site') current = { ...current, session: { ...current.session, actor: { ...current.session.actor, siteIds: [] } } };
        if (change === 'action-site') current = { ...current, session: { ...current.session, actor: { ...current.session.actor, actionSiteIds: [] } } };
        if (change === 'api') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.example.test');
        if (change === 'observation-expiry') vi.setSystemTime(now + ACCESS_CLOSURE_OBSERVATION_MS);
        if (change === 'factor-expiry') vi.setSystemTime(now + 2);
        if (change === 'flow-phase') permission.phase = 'reviewed';
      }));
      return 'token';
    });
    const code = change === 'retained-input' ? 'ORIGINAL_INPUT_AVAILABLE' : change === 'factor-expiry' ? 'STEP_UP_REQUIRED' : ['epoch', 'observation-expiry', 'flow-phase'].includes(change) ? 'RECOVERY_REVIEW_REQUIRED' : 'RECOVERY_SCOPE_CHANGED';
    await expect(closeAccessRecovery(value, permission, { current: () => current, selected: () => selected, hasOriginal: () => original, getToken: token, signal: new AbortController().signal }, dispatched)).rejects.toMatchObject({ code });
    expect(changed).toBe(true); expect(token).toHaveBeenCalledTimes(1); expect(dispatched).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['stored-reference', 'action-ownership'] as const)('rejects changed %s at the synchronous dispatch callback without classifying it as network loss', async change => {
    const value = await review(), entries = new Map<string, string>();
    const storage = { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, text: string) => { entries.set(key, text); }, removeItem: (key: string) => { entries.delete(key); } };
    expect(saveAccessRecovery(storage, locator)).toBe(true);
    const fetcher = transport(); let ownsAction = true;
    const failure = new RequestError(change === 'stored-reference' ? 'RECOVERY_REFERENCE_CHANGED' : 'RECOVERY_ACTION_CHANGED', 'The pending close no longer matches.');
    const getToken = async () => { queueMicrotask(() => queueMicrotask(() => {
      if (change === 'stored-reference') storage.setItem(storage.key(0)!, JSON.stringify({ ...locator, kind: 'revoke' }));
      else ownsAction = false;
    })); return 'token'; };
    const onDispatch = vi.fn((): undefined => { if (!ownsAction || !accessRecoveryStored(storage, locator)) throw failure; return undefined; });
    await expect(closeAccessRecovery(value, permitted(value), { ...context(), getToken }, onDispatch)).rejects.toBe(failure);
    expect(onDispatch).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
    expect(readAccessRecovery(storage, locator)).toEqual(change === 'stored-reference' ? { ...locator, kind: 'revoke' } : locator);
  });
  it('performs the successful exact dispatch check once after the final handoff and immediately before the one fetch', async () => {
    const value = await review(), order: string[] = [];
    const fetcher = vi.fn(async () => { order.push('fetch'); return json(result('grant', 'fenced')); }); vi.stubGlobal('fetch', fetcher);
    const getToken = async () => { order.push('token'); queueMicrotask(() => { order.push('first microtask'); queueMicrotask(() => { order.push('final microtask'); }); }); return 'token'; };
    const onDispatch = vi.fn((): undefined => { order.push('exact dispatch check'); return undefined; });
    await expect(closeAccessRecovery(value, permitted(value), { ...context(), getToken }, onDispatch)).resolves.toMatchObject({ disposition: 'fenced' });
    expect(order).toEqual(['token', 'first microtask', 'final microtask', 'exact dispatch check', 'fetch']); expect(fetcher).toHaveBeenCalledTimes(1); expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});
