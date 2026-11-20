import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { paidToolFixture } from './native-paid-tool.test-fixtures';
import { clearPaidToolAttempt, createPaidToolAttempt, paidToolListSchema, paidToolPath, paidToolReadSchema, paidToolRecoverySchema, paidToolRequest, readPaidToolAttempt, recoverPaidToolControl, sendPaidToolControl, storePaidToolAttempt } from './native-paid-tool';
import type { AgentWorkStorage } from './native-agent-work';
const scope = { apiBase: 'http://localhost:3108', environment: 'development' as const, organizationId: 'hidden-org', siteId: 'hidden-site', actorId: 'actor', sessionId: 'session' };
const storage = (): AgentWorkStorage => { const map = new Map<string,string>(); return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: key => map.get(key) ?? null, setItem: (key,value) => { map.set(key,value); }, removeItem: key => { map.delete(key); } }; };
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', scope.apiBase));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('paid purchase scoped client', () => {
  it('rejects returned root, nested scope, operation and duplicate list substitutions', () => {
    const purchase = paidToolFixture(), response = { scope: purchase.scope, rootTaskId: purchase.rootTaskId, purchase }, list = { scope: purchase.scope, rootTaskId: purchase.rootTaskId, purchases: [purchase] };
    expect(paidToolReadSchema(scope, purchase.rootTaskId, purchase.operationId).safeParse(response).success).toBe(true);
    expect(paidToolListSchema(scope, purchase.rootTaskId).safeParse(list).success).toBe(true);
    for (const p of [{ ...purchase, rootTaskId: 'other' }, { ...purchase, scope: { ...purchase.scope, organizationId: 'other' } }, { ...purchase, operationId: 'other' }]) expect(paidToolReadSchema(scope, purchase.rootTaskId, purchase.operationId).safeParse({ ...response, purchase: p }).success).toBe(false);
    expect(paidToolListSchema(scope, purchase.rootTaskId).safeParse({ ...list, purchases: [purchase,purchase] }).success).toBe(false);
  });
  it('allows only purchase paths with correct method and refuses effect routes', async () => {
    const fetch = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetch);
    for (const path of ['/v1/voice/speak','/v1/agent-work/root/purchases/op/approve','/v1/agent-work/root/purchases?siteId=site&other=1']) await expect(paidToolRequest(path, z.object({}), scope, async () => 'token', () => scope)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(paidToolRequest(paidToolPath('root','site','op','control'), z.object({}), scope, async () => 'token', () => scope)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fences token-await and response-await scope switches', async () => {
    let current = scope; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(paidToolRequest(paidToolPath('root','site'), z.object({}), scope, async () => { current = { ...scope, sessionId: 'other' }; return 'token'; }, () => current)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' }); expect(fetch).not.toHaveBeenCalled();
    current = scope; fetch.mockImplementation(async () => { current = { ...scope, siteId: 'other' }; return Response.json({}); });
    await expect(paidToolRequest(paidToolPath('root','site'), z.object({}), scope, async () => 'token', () => current)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
  });
  it('persists one exact action and blocks replacement or a new service origin', async () => {
    const store = storage(), attempt = await createPaidToolAttempt(scope,'root','op',1,'revoke'); storePaidToolAttempt(store, attempt);
    expect(readPaidToolAttempt(store,scope,'root','op')).toEqual(attempt);
    expect(() => storePaidToolAttempt(store,{ ...attempt, command: { ...attempt.command, commandKey: 'new' } })).toThrow();
    expect(() => storePaidToolAttempt(store,{ ...attempt, scope: { ...scope, apiBase: 'https://other.example' } })).toThrow();
    clearPaidToolAttempt(store,attempt); expect(store.length).toBe(0);
  });
  it('fails closed if storage drops the retained command', async () => {
    const store = storage(); store.setItem = () => {}; const attempt = await createPaidToolAttempt(scope,'root','op',1,'revoke'); expect(() => storePaidToolAttempt(store,attempt)).toThrow();
  });
  it('sends an exact command and recovers by its original hash without replay', async () => {
    const p = paidToolFixture(), attempt = await createPaidToolAttempt(scope,p.rootTaskId,p.operationId,1,'revoke');
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ scope: p.scope, rootTaskId: p.rootTaskId, purchase: { ...p, version: 2 } })).mockResolvedValueOnce(Response.json({ scope: p.scope, rootTaskId: p.rootTaskId, recovery: null })); vi.stubGlobal('fetch', fetch);
    await sendPaidToolControl(attempt,async () => 'token',() => scope); await recoverPaidToolControl(attempt,async () => 'token',() => scope);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ siteId: scope.siteId, commandKey: attempt.command.commandKey, expectedVersion: 1, kind: 'revoke' });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ siteId: scope.siteId, commandKey: attempt.command.commandKey, commandHash: attempt.commandHash });
    expect(fetch.mock.calls[1]![0]).toContain('/recover');
  });
  it('requires recovery receipt identity/version binding and rejects tampered retained commands before dispatch', async () => {
    const p = paidToolFixture(), a = await createPaidToolAttempt(scope,p.rootTaskId,p.operationId,1,'revoke');
    const value = { scope: p.scope, rootTaskId: p.rootTaskId, recovery: { purchase: { ...p, version: 2 }, receipt: { commandKey: a.command.commandKey, commandHash: a.commandHash, previousVersion: 1, version: 2, recordedAt: p.asOf, status: p.state } } };
    expect(paidToolRecoverySchema(a).safeParse(value).success).toBe(true);
    for (const receipt of [{ ...value.recovery.receipt, commandHash: 'a'.repeat(64) }, { ...value.recovery.receipt, previousVersion: 2 }, { ...value.recovery.receipt, commandKey: 'other' }]) expect(paidToolRecoverySchema(a).safeParse({ ...value, recovery: { ...value.recovery, receipt } }).success).toBe(false);
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch); await expect(sendPaidToolControl({ ...a, command: { ...a.command, kind: 'cancel_before_signing' } },async () => 'token',() => scope)).rejects.toMatchObject({ code: 'LOCAL_RECOVERY_INVALID' }); expect(fetch).not.toHaveBeenCalled();
  });
});
