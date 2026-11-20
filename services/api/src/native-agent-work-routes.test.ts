import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app';
import type { NativeAgentWorkRepository } from './native-agent-work-routes';

const at = '2026-11-18T12:00:00Z', origin = 'https://pactwoven.vercel.app';
const headers = { Authorization: 'Bearer synthetic', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'original_root_control_001' };
function fixture() {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office', 'warehouse'], actionSiteIds: ['office', 'warehouse'], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }, { id: 'warehouse', name: 'Warehouse', timeZone: 'America/Chicago' }] };
  const identity: VerifiedIdentity = { subject: 'external', externalOrganizationId: 'org_external', sessionId: 'session', externalOrganizationName: 'Company',
    externalMembershipId: 'member', externalRole: 'org:admin', authenticatedAt: at, membershipObservedAt: at };
  const scope = { environment: 'development' as const, organizationId: 'org', siteId: 'office' };
  const view = { scope, id: 'root_work', title: 'Workshop plan', prompt: 'Prepare workshop advice.', controlVersion: 1,
    state: 'running', reason: 'none', checkpointVersion: 2, checkpoint: { stage: 'working', summary: 'Comparing workshop formats', steps: [{ id: 'step_one', title: 'Compare options', state: 'active' }] },
    checkpointHistorical: false, attempt: 1, attemptLimit: 4, generation: 3, coverage: [], result: null,
    updatedAt: at, expiresAt: '2026-11-19T12:00:00Z', evidenceUnavailable: false, domainCompletion: false };
  const receipt = { scope, operationId: '83739145-8e8b-4914-aeca-665dacb15df5', rootTaskId: view.id, action: 'pause',
    controlVersion: 2, generation: 4, state: 'paused', committedAt: at };
  const repository: NativeAgentWorkRepository = { read: vi.fn(async () => view), control: vi.fn(async () => receipt), recover: vi.fn(async () => receipt) };
  const lists = { list: vi.fn(async () => ({ scope, items: [{ id: view.id, title: view.title, state: 'working' as const,
    createdAt: at, updatedAt: at, expiresAt: view.expiresAt }], nextCursor: null })) };
  const foundation: FoundationRepository = { getSession: vi.fn(async () => session), listResponsibilities: vi.fn(), getResponsibility: vi.fn(), createResponsibility: vi.fn() };
  const verifyIdentity = vi.fn(async () => identity);
  const app = createApp({ allowedOrigins: [origin], repository: foundation, verifyIdentity, nativeAgentWorkRepository: repository, nativeAgentWorkListRepository: lists }, { surface: 'native' });
  const get = (suffix = '?siteId=office') => app.request('/v1/agent-work/root_work' + suffix, { headers });
  const control = (body: unknown = { action: 'pause', expectedVersion: 1 }, suffix = '?siteId=office') => app.request('/v1/agent-work/root_work/control' + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, get, control, repository, lists, session, foundation, verifyIdentity, view, scope, receipt };
}
describe('public delegated work read and controls', () => {
  it('lists only scoped metadata with validated filters', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/agent-work?siteId=office&limit=20&filter=active&q=Workshop', { headers });
    expect(response.status).toBe(200);expect((await response.json()).items[0].id).toBe(f.view.id);
    expect(f.lists.list).toHaveBeenCalledExactlyOnceWith(f.session.actor, { siteId: 'office', limit: 20, filter: 'active', q: 'Workshop' });
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('rejects cross-scope and duplicate-item pages', async () => {
    const f = fixture(), page = await f.lists.list();
    for (const result of [{ ...page, scope: { ...page.scope, siteId: 'warehouse' } }, { ...page, items: [...page.items, ...page.items] }]) {
      f.lists.list.mockResolvedValueOnce(result);
      expect((await f.app.request('/v1/agent-work?siteId=office', { headers })).status).toBe(503);
    }
    f.lists.list.mockClear();
    expect((await f.app.request('/v1/agent-work?siteId=office&siteId=warehouse', { headers })).status).toBe(422);
    expect(f.lists.list).not.toHaveBeenCalled();
  });
  it('projects real work without private worker mechanics', async () => {
    const f = fixture(), response = await f.get(); expect(response.status).toBe(200); const result = await response.json();
    expect(result.scope).toEqual(f.scope); expect(result.work).toMatchObject({ title: 'Workshop plan', siteName: 'Office', state: 'working', availableActions: ['pause', 'cancel'], continuesAfterSignOut: true });
    expect(result.work.progress.steps[0]).toEqual(f.view.checkpoint.steps[0]);
    for (const key of ['generation', 'attempt', 'attemptLimit', 'coverage', 'checkpointVersion', 'domainCompletion']) expect(result.work).not.toHaveProperty(key);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each(['?siteId=office&path=root_work', '?siteId=office&siteId=warehouse', '?siteId=office&organizationId=another', '?siteId=missing'])('rejects invalid selectors %s', async suffix => {
    const f = fixture(); expect([403, 422]).toContain((await f.get(suffix)).status); expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('denies foreign-origin and unsigned requests before reading', async () => {
    const f = fixture();
    expect((await f.app.request('/v1/agent-work/root_work?siteId=office')).status).toBe(401);
    expect((await f.app.request('/v1/agent-work/root_work?siteId=office', { headers: { ...headers, Origin: 'https://other.invalid' } })).status).toBe(403);
    expect(f.repository.read).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it.each(['site', 'organization', 'id'])('rejects a substituted %s response', async kind => {
    const f = fixture();
    vi.mocked(f.repository.read).mockResolvedValueOnce({ ...f.view, ...(kind === 'id' ? { id: 'another' } : { scope: { ...f.scope, ...(kind === 'site' ? { siteId: 'warehouse' } : { organizationId: 'another' }) } }) });
    expect((await f.get()).status).toBe(503);
  });
  it('never returns protected bodies alongside an evidence-withheld marker', async () => {
    const f = fixture();vi.mocked(f.repository.read).mockResolvedValueOnce({ ...f.view, evidenceUnavailable: true });
    expect((await f.get()).status).toBe(503);
    vi.mocked(f.repository.read).mockResolvedValueOnce({ ...f.view, checkpoint: null, evidenceUnavailable: true });
    const r = await f.get();expect(r.status).toBe(200);expect((await r.json()).work).toMatchObject({ evidenceUnavailable: true, progress: null, result: null });
  });
  it('retains readonly viewing but exposes no write actions after write authority is removed', async () => {
    const f = fixture();f.session.actor.roles = ['auditor'];f.session.actor.actionSiteIds = [];
    expect((await (await f.get()).json()).work.availableActions).toEqual([]);
    expect((await f.control()).status).toBe(403);expect(f.repository.control).not.toHaveBeenCalled();
  });
  it('checks actual root site before making a control write even when both sites are assigned', async () => {
    const f = fixture();expect((await f.control(undefined, '?siteId=warehouse')).status).toBe(503);expect(f.repository.control).not.toHaveBeenCalled();
  });
  it('sends exactly one original control with no browser authority fields', async () => {
    const f = fixture(), response = await f.control();expect(response.status).toBe(200);
    expect(f.repository.control).toHaveBeenCalledExactlyOnceWith(f.session.actor, headers['Idempotency-Key'], { rootTaskId: 'root_work', action: 'pause', expectedVersion: 1 });
    const result = await response.json();expect(result.state).toBe('paused');expect(result).not.toHaveProperty('generation');
    expect((await f.control({ action: 'pause', expectedVersion: 1, rootTaskId: 'another' })).status).toBe(422);
  });
  it('preserves uncertain writes and does not retry a lost acknowledgement', async () => {
    const f = fixture();vi.mocked(f.repository.control).mockRejectedValueOnce(Error('private-connection-string'));
    const response = await f.control();expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-connection-string');
    expect(f.repository.control).toHaveBeenCalledOnce();expect(f.repository.recover).not.toHaveBeenCalled();
  });
  it('keeps an original control recoverable after write authority is lost', async () => {
    const f = fixture();f.session.actor.roles = ['auditor'];f.session.actor.actionSiteIds = [];
    const response = await f.app.request('/v1/agent-work/root_work/controls/' + headers['Idempotency-Key'] + '?siteId=office', { headers });
    expect(response.status).toBe(200);expect((await response.json()).operation.rootTaskId).toBe('root_work');expect(f.repository.control).not.toHaveBeenCalled();
  });
  it('returns current version conflicts unchanged without a second command', async () => {
    const f = fixture();vi.mocked(f.repository.control).mockRejectedValueOnce(new DomainError('ROOT_CONFLICT', 409, 'The retained work changed.'));
    expect((await f.control()).status).toBe(409);expect(f.repository.control).toHaveBeenCalledOnce();
  });
});
