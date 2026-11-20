import { Hono } from 'hono';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import type { Session } from '@pactwoven/contracts';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { FINANCE_DEVNET_ASSET, encodeSolanaBase58 } from '../../../packages/contracts/src/finance-provenance';
import type { ApiEnv } from './app';
import { isNativePaidToolHttpRoute, registerNativePaidToolRoutes } from './native-paid-tool-routes';

const at = '2026-11-19T16:00:00Z', hash = 'a'.repeat(64), key = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
function setup(connected = true) {
  const session: Session = { actor: { actorId: 'human', principalKind: 'human', environment: 'development', organizationId: 'org', roles: ['owner'], siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session', authenticatedAt: at, correlationId: 'correlation' }, organization: { id: 'org', name: 'Workspace', authorityEpoch: 1 }, sites: [{ id: 'site', name: 'Office', timeZone: 'America/Chicago' }] };
  const snapshot = { currentInstructionRevision: 0, evidenceAvailable: true, operationId: 'operation', version: 1, status: 'authorized', approvedAt: at, revokedAt: null,
    review: { id: 'review', organizationId: 'org', siteId: 'site', rootTaskId: 'root', instructionRevision: 0, quoteId: 'quote', quoteHash: hash, providerId: 'equipment_optimizer_v1', amountBaseUnits: '10000', maximumFeeLamports: '15000', sourceAccount: key(1), sourceOwner: key(2), feePayer: key(2), destinationAccount: key(3), destinationOwner: key(4), ...FINANCE_DEVNET_ASSET, expiresAt: '2026-11-19T16:05:00Z', reviewHash: hash }, message: null, attempt: null, payment: null, delivery: null };
  const command = { operationId: 'operation', commandKey: 'original-command', expectedVersion: 1, kind: 'revoke' as const };
  const repository = { read: vi.fn(async () => snapshot), list: vi.fn(async () => ({ rootTaskId: 'root', items: [snapshot] })),
    control: vi.fn(async (_actor: unknown, input: typeof command) => ({ snapshot: { ...snapshot, version: 2, revokedAt: at }, receipt: { commandKey: input.commandKey, commandHash: await commandDigest({ namespace: 'pactwoven.paid-tool-command.v1', command: input }), previousVersion: 1, version: 2, recordedAt: at, status: 'authorized' } })), recover: vi.fn(async (): Promise<unknown> => null) };
  const app = new Hono<ApiEnv>();
  // Real Hono middleware ordering, synthetic session issuer; no provider login claim.
  app.use('*', async (c, next) => { if (c.req.header('authorization') !== 'Bearer fixture') return c.json({ error: 'UNAUTHENTICATED' }, 401); c.set('session', session); if (c.req.method === 'POST') c.set('requestBody', await c.req.json()); await next(); });
  app.onError((error,c) => error instanceof DomainError ? c.json({ error: error.code }, error.status as 403 | 409 | 422 | 503) : error instanceof ZodError ? c.json({ error: 'VALIDATION_FAILED' }, 422) : c.json({ error: 'UNEXPECTED' }, 500));
  registerNativePaidToolRoutes(app, connected ? repository as never : undefined, () => at);
  const get = (path = '/v1/agent-work/root/purchases/operation?siteId=site') => app.request(path, { headers: { authorization: 'Bearer fixture' } });
  const post = (suffix: 'control' | 'recover', body: unknown, root = 'root') => app.request(`/v1/agent-work/${root}/purchases/operation/${suffix}`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { session, snapshot, command, repository, app, get, post };
}
describe('independent paid-tool route admission and original control recovery', () => {
  it('keeps signing, broadcast and approval absent from the route family', () => {
    expect(isNativePaidToolHttpRoute('/v1/agent-work/root/purchases/operation/control','POST')).toBe(true);
    for (const action of ['approve','sign','broadcast','control','recover']) expect(isNativePaidToolHttpRoute(`/v1/agent-work/root/purchases/operation/${action}`,'GET')).toBe(false);
    for (const action of ['approve','sign','broadcast']) expect(isNativePaidToolHttpRoute(`/v1/agent-work/root/purchases/operation/${action}`,'POST')).toBe(false);
  });
  it('requires middleware authentication before any repository read', async () => {
    const f = setup(); expect((await f.app.request('/v1/agent-work/root/purchases?siteId=site')).status).toBe(401); expect(f.repository.list).not.toHaveBeenCalled();
  });
  it.each(['principal','environment','memberSite','sessionSite'])('rejects invalid %s access before repository reads', async kind => {
    const f = setup(); if (kind === 'principal') f.session.actor.principalKind = 'service'; if (kind === 'environment') f.session.actor.environment = 'production'; if (kind === 'memberSite') f.session.actor.siteIds = []; if (kind === 'sessionSite') f.session.sites = [];
    expect((await f.get()).status).toBe(403); expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('permits read-only reconciliation but forbids read-only mutation', async () => {
    const f = setup(); f.session.actor.actionSiteIds = []; f.session.actor.roles = ['auditor'];
    expect((await f.get()).status).toBe(200); const { operationId, ...body } = f.command;
    expect((await f.post('control',{ siteId: 'site', ...body })).status).toBe(403); expect(f.repository.control).not.toHaveBeenCalled();
    expect((await f.post('recover',{ siteId: 'site', commandKey: body.commandKey, commandHash: hash })).status).toBe(200);
  });
  it.each(['?siteId=site&siteId=site','?siteId=site&role=owner',''])('rejects ambiguous query %s without reading', async query => {
    const f = setup(); expect((await f.get('/v1/agent-work/root/purchases'+query)).status).toBe(422); expect(f.repository.list).not.toHaveBeenCalled();
  });
  it.each(['root','site','organization','operation'])('rejects URL %s affinity before control mutation', async kind => {
    const f = setup(); if (kind === 'root') f.snapshot.review.rootTaskId = 'foreign'; if (kind === 'site') f.snapshot.review.siteId = 'foreign'; if (kind === 'organization') f.snapshot.review.organizationId = 'foreign'; if (kind === 'operation') f.snapshot.operationId = 'foreign';
    const { operationId, ...body } = f.command; expect((await f.post('control',{ siteId: 'site', ...body })).status).toBeGreaterThanOrEqual(400); expect(f.repository.control).not.toHaveBeenCalled();
  });
  it('rejects list duplicates and foreign root without leaking their contents', async () => {
    const f = setup(); f.repository.list.mockResolvedValueOnce({ rootTaskId: 'root', items: [f.snapshot,f.snapshot] }); expect((await f.get('/v1/agent-work/root/purchases?siteId=site')).status).toBe(409);
    f.repository.list.mockResolvedValueOnce({ rootTaskId: 'foreign', items: [f.snapshot] }); expect((await f.get('/v1/agent-work/root/purchases?siteId=site')).status).toBe(409);
  });
  it('sends exact current-actor controls and validates the returned receipt', async () => {
    const f = setup(), { operationId, ...body } = f.command, response = await f.post('control',{ siteId: 'site', ...body });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(f.repository.control).toHaveBeenCalledExactlyOnceWith(f.session.actor,f.command);
    const payload = await response.json(); expect(payload.purchase.version).toBe(2); expect(payload).not.toHaveProperty('snapshot'); expect(payload.purchase).not.toHaveProperty('review');
  });
  it.each(['hash','key','previousVersion','version'])('rejects a changed control receipt %s', async kind => {
    const f = setup(), valid = await f.repository.control(f.session.actor,f.command); if (kind === 'hash') valid.receipt.commandHash = 'b'.repeat(64); if (kind === 'key') valid.receipt.commandKey = 'other'; if (kind === 'previousVersion') valid.receipt.previousVersion = 2; if (kind === 'version') valid.receipt.version = 3;
    f.repository.control.mockResolvedValueOnce(valid); const { operationId, ...body } = f.command; expect((await f.post('control',{ siteId: 'site', ...body })).status).toBe(409);
  });
  it('recovers an original control after expiry and revocation without calling control', async () => {
    const f = setup(); f.snapshot.review.expiresAt = '2020-01-01T00:00:00Z'; const recovered = await f.repository.control(f.session.actor,f.command); f.repository.control.mockClear(); f.repository.recover.mockResolvedValueOnce(recovered);
    const body = { siteId: 'site', commandKey: recovered.receipt.commandKey, commandHash: recovered.receipt.commandHash }, response = await f.post('recover',body);
    expect(response.status).toBe(200); expect(f.repository.control).not.toHaveBeenCalled(); expect(f.repository.recover).toHaveBeenCalledExactlyOnceWith(f.session.actor,'root','site',{ kind: 'control', operationId: 'operation', commandKey: body.commandKey, commandHash: body.commandHash }); const actions=(await response.json()).recovery.purchase.actions; expect(actions).toContain('check'); expect(actions).not.toContain('revoke');
  });
  it('returns null recovery without fabricating a successful mutation', async () => { const f = setup(); const response = await f.post('recover',{ siteId: 'site', commandKey: 'missing', commandHash: hash }); expect((await response.json()).recovery).toBeNull(); expect(f.repository.control).not.toHaveBeenCalled(); });
  it('rejects a recovery receipt for another original command', async () => {
    const f = setup(), recovered = await f.repository.control(f.session.actor,f.command); f.repository.recover.mockResolvedValueOnce(recovered); expect((await f.post('recover',{ siteId: 'site', commandKey: 'foreign', commandHash: recovered.receipt.commandHash })).status).toBe(409);
  });
  it('fails closed with no repository', async () => { const f = setup(false); expect((await f.get()).status).toBe(503); expect(f.repository.read).not.toHaveBeenCalled(); });
});
