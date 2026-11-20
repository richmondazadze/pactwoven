import { describe, expect, it, vi } from 'vitest';
import { NativeTaskSummarySchema, type NativeTask, type NativeTaskRepository, type NativeWorkIntentRepository, type Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';

const origin = 'http://localhost:3001';
const now = '2026-11-18T12:00:00.000Z';
const session: Session = {
  actor: { actorId: 'operator_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: now, correlationId: 'test_a' },
  organization: { id: 'org_a', name: 'Test company', authorityEpoch: 1 },
  sites: [{ id: 'site_a', name: 'Office', timeZone: 'America/Chicago' }],
};
const identity: VerifiedIdentity = { subject: 'external_a', externalOrganizationId: 'external_org_a', sessionId: 'session_a',
  externalOrganizationName: 'Test company', externalMembershipId: 'member_a', externalRole: 'org:admin', authenticatedAt: now, membershipObservedAt: now };
const task: NativeTask = { id: 'work_a', title: 'Compare office chairs', status: 'queued', phase: 'Ready to start', siteId: 'site_a',
  createdAt: now, updatedAt: now, version: 1, availableActions: ['pause', 'cancel', 'message'], prompt: 'Compare office chairs',
  mode: 'advise', steps: [], messages: [], artifacts: [], events: [] };
const headers = { Authorization: 'Bearer test-token', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'native_task_request_0001' };
const input = { prompt: task.prompt, siteId: task.siteId };
function fixture(current: Session = structuredClone(session), nativeOnly = false, provenance?: Pick<NativeWorkIntentRepository, 'provenance'>) {
  const foundation: FoundationRepository = {
    getSession: vi.fn(async () => current), listResponsibilities: vi.fn(), getResponsibility: vi.fn(), createResponsibility: vi.fn(),
  };
  const repository: NativeTaskRepository = { create: vi.fn(async () => structuredClone(task)),
    list: vi.fn(async () => []), search: vi.fn(async () => ({ items: [], nextCursor: null })), get: vi.fn(async () => structuredClone(task)),
    control: vi.fn(async () => ({ ...structuredClone(task), status: 'paused' as const, version: 2, availableActions: ['resume' as const, 'cancel' as const] })),
    reply: vi.fn(async () => ({ ...structuredClone(task), version: 2 })),
  };
  const app = createApp({ repository: foundation, nativeTaskRepository: repository, ...(provenance ? { nativeTaskProvenance: provenance } : {}), verifyIdentity: vi.fn(async () => identity), allowedOrigins: [origin] }, { surface: nativeOnly ? 'native' : 'workspace' });
  return { app, repository, foundation };
}

describe('native task authenticated HTTP boundaries', () => {
  it('mounts only native work on the separate host while retaining current session checks', async () => {
    const { app, foundation, repository } = fixture(structuredClone(session), true);
    for (const path of ['/v1/organizations/bootstrap', '/v1/session', '/v1/responsibilities', '/v1/access', '/v1/financial-policies', '/v1/custody']) {
      expect((await app.request(path, { headers })).status).toBe(404);
    }
    expect(foundation.getSession).not.toHaveBeenCalled();
    expect((await app.request('/v1/tasks', { headers })).status).toBe(200);
    expect(foundation.getSession).toHaveBeenCalledOnce();
    expect(repository.search).toHaveBeenCalledWith(session.actor, { limit: 50, q: '', filter: 'all' });
    expect((await app.request('/v1/tasks')).status).toBe(401);
    expect((await app.request('/v1/tasks', { headers: { ...headers, Origin: 'https://other.example' } })).status).toBe(403);
    expect(foundation.createResponsibility).not.toHaveBeenCalled();
  });
  it('requires a current session and rejects cross-origin requests before task access', async () => {
    const { app, repository, foundation } = fixture();
    expect((await app.request('/v1/tasks')).status).toBe(401);
    expect((await app.request('/v1/tasks', { headers: { ...headers, Origin: 'https://other.example' } })).status).toBe(403);
    vi.mocked(foundation.getSession).mockRejectedValueOnce(new DomainError('FORBIDDEN', 403, 'Access changed.'));
    expect((await app.request('/v1/tasks', { headers })).status).toBe(403);
    expect(repository.search).not.toHaveBeenCalled();
  });
  it('creates from the verified actor, returns a scoped projection and preserves the recovery key', async () => {
    const { app, repository } = fixture();
    const response = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/v1/tasks/work_a');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ scope: { environment: 'development', organizationId: 'org_a' }, task });
    expect(repository.create).toHaveBeenCalledWith(session.actor, headers['Idempotency-Key'], { ...input, mode: 'advise' });
  });
  it('rejects client-supplied identity, authority, unsupported action modes and unbounded prompts', async () => {
    const { app, repository } = fixture();
    for (const changed of [{ actorId: 'other' }, { mode: 'act' }, { prompt: 'x'.repeat(12001) }, { prompt: ' ' }, { organizationId: 'other' }]) {
      expect((await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ ...input, ...changed }) })).status).toBe(422);
    }
    expect(repository.create).not.toHaveBeenCalled();
  });
  it('limits creation to an operator with current site action access', async () => {
    for (const actor of [{ ...session.actor, actionSiteIds: [] }, { ...session.actor, roles: ['auditor' as const] }, { ...session.actor, principalKind: 'service' as const }]) {
      const { app, repository } = fixture({ ...session, actor });
      expect((await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(403);
      expect(repository.create).not.toHaveBeenCalled();
    }
  });
  it('bounds list inputs and rejects duplicate or unsupported filters', async () => {
    const { app, repository } = fixture();
    for (const query of ['limit=101', 'limit=0', 'limit=1&limit=50', 'organizationId=other', 'limit=abc', 'filter=failed',
      'q=a&q=b', 'filter=all&filter=active', 'cursor=a&cursor=b', 'cursor=', 'cursor=%20', 'cursor=' + 'x'.repeat(2049),
      'q=' + 'x'.repeat(181), 'q=%00', 'q=' + '%01'.repeat(180), 'q=a%0Ab', 'q=a%7Fb']) {
      expect((await app.request(`/v1/tasks?${query}`, { headers })).status).toBe(422);
    }
    expect(repository.search).not.toHaveBeenCalled();
    expect((await app.request('/v1/tasks?limit=50', { headers })).status).toBe(200);
    expect(repository.search).toHaveBeenCalledWith(session.actor, { limit: 50, q: '', filter: 'all' });
  });
  it('forwards scoped title search and pagination without truncating to the old list', async () => {
    const { app, repository } = fixture();
    const response = await app.request('/v1/tasks?limit=25&q=%20Chair%20&filter=active&cursor=encoded_cursor', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope: { environment: 'development', organizationId: 'org_a' }, items: [], nextCursor: null });
    expect(repository.search).toHaveBeenCalledWith(session.actor, { limit: 25, q: 'Chair', filter: 'active', cursor: 'encoded_cursor' });
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('rejects unscoped, overfull, looping and malformed page projections', async () => {
    const { app, repository } = fixture();
    const summary = NativeTaskSummarySchema.parse(Object.fromEntries(Object.entries(task).filter(([key]) =>
      ['id','title','status','phase','siteId','createdAt','updatedAt','version','availableActions'].includes(key))));
    for (const page of [{ items: [{ ...summary, siteId: 'other' }], nextCursor: null },
      { items: [summary, summary], nextCursor: null }, { items: [], nextCursor: 'next' },
      { items: [{ ...summary, checkpoint: 'private-test-value' }], nextCursor: null },
      { items: [summary], nextCursor: 'same' }, { items: [summary], nextCursor: 'bad cursor' }]) {
      vi.mocked(repository.search).mockResolvedValueOnce(page);
      const response = await app.request('/v1/tasks?limit=1&cursor=same', { headers });
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-test-value');
    }
  });
  it('fails closed for private worker data, mismatched records and out-of-scope sites', async () => {
    const { app, repository } = fixture();
    for (const changed of [{ checkpoint: { privateValue: 'sensitive-test-data' } }, { siteId: 'site_other' }, { id: 'other_task' }]) {
      vi.mocked(repository.get).mockResolvedValueOnce({ ...task, ...changed });
      const response = await app.request('/v1/tasks/work_a', { headers });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('sensitive-test-data');
    }
  });
  it('passes exact versions and reply identities; conflicts remain conflicts', async () => {
    const { app, repository } = fixture();
    const control = { action: 'pause', expectedVersion: 1 };
    expect((await app.request('/v1/tasks/work_a/control', { method: 'POST', headers, body: JSON.stringify(control) })).status).toBe(200);
    expect(repository.control).toHaveBeenCalledWith(session.actor, 'work_a', control);
    const reply = { text: 'Choose ergonomic chairs', expectedVersion: 2 };
    vi.mocked(repository.reply).mockRejectedValueOnce(new DomainError('VERSION_CONFLICT', 409, 'This task has changed. Refresh to continue.'));
    expect((await app.request('/v1/tasks/work_a/messages', { method: 'POST', headers, body: JSON.stringify(reply) })).status).toBe(409);
    expect(repository.reply).toHaveBeenCalledWith(session.actor, 'work_a', headers['Idempotency-Key'], reply);
  });
});

describe('legacy provenance navigation and mutation fencing', () => {
  const mapped = () => ({ scope: { environment: 'development' as const, organizationId: 'org_a', siteId: 'site_a' }, items: [{ provenanceId: 'work_a', rootTaskId: 'team_work' }] });
  const summary = () => NativeTaskSummarySchema.parse(Object.fromEntries(Object.entries(task).filter(([key]) =>
    ['id','title','status','phase','siteId','createdAt','updatedAt','version','availableActions'].includes(key))));
  it('suppresses only mapped legacy records and keeps the original cursor even on an empty page', async () => {
    const provenance = { provenance: vi.fn(async () => mapped()) }, { app, repository } = fixture(structuredClone(session), true, provenance);
    vi.mocked(repository.search).mockResolvedValue({ items: [summary()], nextCursor: 'next_page' });
    const response = await app.request('/v1/tasks?limit=1', { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ scope: { environment: 'development', organizationId: 'org_a' }, items: [], nextCursor: 'next_page' });
    expect(provenance.provenance).toHaveBeenCalledWith(session.actor, 'site_a', ['work_a']);
  });
  it('returns only scoped navigation metadata for the original reference', async () => {
    const { app } = fixture(structuredClone(session), true, { provenance: vi.fn(async () => mapped()) });
    const response = await app.request('/v1/tasks/work_a/continuation', { headers });
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ scope: { environment: 'development', organizationId: 'org_a' }, taskId: 'work_a', continuation: { kind: 'agent_work', id: 'team_work', siteId: 'site_a' } });
  });
  it('blocks legacy reads, resume and replies for delegated roots before dispatching a legacy mutation', async () => {
    const { app, repository } = fixture(structuredClone(session), true, { provenance: vi.fn(async () => mapped()) });
    for (const [suffix, body] of [['', null], ['/control', { action: 'resume', expectedVersion: 1 }], ['/messages', { text: 'Continue', expectedVersion: 1 }]] as const) {
      const response = await app.request(`/v1/tasks/work_a${suffix}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      expect(response.status).toBe(409);expect((await response.json()).error.code).toBe('WORK_CONTINUES_ELSEWHERE');
    }
    expect(repository.control).not.toHaveBeenCalled();expect(repository.reply).not.toHaveBeenCalled();
  });
  it('keeps genuine legacy tasks readable and controllable', async () => {
    const { app, repository } = fixture(structuredClone(session), true, { provenance: vi.fn(async () => ({ ...mapped(), items: [] })) });
    expect((await app.request('/v1/tasks/work_a', { headers })).status).toBe(200);
    expect((await (await app.request('/v1/tasks/work_a/continuation', { headers })).json()).continuation).toBeNull();
    expect((await app.request('/v1/tasks/work_a/control', { headers, method: 'POST', body: JSON.stringify({ action: 'pause', expectedVersion: 1 }) })).status).toBe(200);
    expect(repository.control).toHaveBeenCalledOnce();
  });
  it('fails closed on unavailable provenance without resuming the inert task', async () => {
    const { app, repository } = fixture(structuredClone(session), true, { provenance: vi.fn(async () => { throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Work unavailable'); }) });
    expect((await app.request('/v1/tasks/work_a/control', { headers, method: 'POST', body: JSON.stringify({ action: 'resume', expectedVersion: 1 }) })).status).toBe(503);
    expect(repository.control).not.toHaveBeenCalled();
  });
  it('rejects fabricated site, root mapping or duplicate provenance records', async () => {
    for (const invalid of [{ ...mapped(), scope: { ...mapped().scope, siteId: 'other' } }, { ...mapped(), items: [{ provenanceId: 'unasked', rootTaskId: 'secret_root' }] }, { ...mapped(), items: [...mapped().items, ...mapped().items] }]) {
      const { app } = fixture(structuredClone(session), true, { provenance: vi.fn(async () => invalid) });
      const response = await app.request('/v1/tasks/work_a/continuation', { headers });
      expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret_root');
    }
  });
});
