import { describe, expect, it, vi } from 'vitest';
import type { NativeMemoryNotesRepository, NativeMemoryNoteDetail, NativeMemoryNoteOperation, Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';

const now = '2026-11-18T12:00:00Z', origin = 'https://pactwoven.vercel.app';
const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
  roles: ['owner'], siteIds: ['office'], actionSiteIds: ['office'], sessionId: 'session', authenticatedAt: now, correlationId: 'test' },
  organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
const identity: VerifiedIdentity = { subject: 'external', externalOrganizationId: 'org_external', sessionId: 'session',
  externalOrganizationName: 'Company', externalMembershipId: 'member', externalRole: 'org:admin', authenticatedAt: now, membershipObservedAt: now };
const scope = { environment: 'development' as const, organizationId: 'org', siteId: 'office' };
const note: NativeMemoryNoteDetail = { id: 'note', title: 'Workshop preference', text: 'Prefer a weekday', purpose: 'Workshop planning',
  siteName: 'Office', suppliedBy: 'You', updatedAt: now, reviewBy: '2026-12-18T12:00:00Z', status: 'available', editToken: 'a'.repeat(64),
  sourceLabel: 'Human statement — not independently verified', usageLabel: 'For permitted work at this site', removalLabel: 'Remove from future work', historyRetained: true };
const summary = { id: note.id, title: note.title, siteName: note.siteName, suppliedBy: note.suppliedBy,
  updatedAt: note.updatedAt, reviewBy: note.reviewBy, status: note.status };
const operation: NativeMemoryNoteOperation = { scope, operationId: 'operation', noteId: note.id, action: 'remember', committedAt: now, current: note };
const input = { kind: 'remember', siteId: 'office', title: note.title, text: note.text, purpose: note.purpose, reviewBy: note.reviewBy };
const headers = { Authorization: 'Bearer test-token', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'memory_request_0001' };
function fixture(current = structuredClone(session)) {
  const foundation: FoundationRepository = { getSession: vi.fn(async () => current), listResponsibilities: vi.fn(), getResponsibility: vi.fn(), createResponsibility: vi.fn() };
  const repository: NativeMemoryNotesRepository = { list: vi.fn(async () => ({ scope, items: [summary], nextCursor: null })),
    get: vi.fn(async () => ({ scope, note })), command: vi.fn(async () => operation), recover: vi.fn(async () => operation) };
  const verifyIdentity = vi.fn(async () => identity);
  return { foundation, repository, verifyIdentity, app: createApp({ allowedOrigins: [origin], repository: foundation, verifyIdentity,
    nativeMemoryNotesRepository: repository }, { surface: 'native' }) };
}
describe('native user memory routes', () => {
  it('requires current identity, membership and allowed origin before reading memory', async () => {
    const f = fixture();
    expect((await f.app.request('/v1/memory?siteId=office')).status).toBe(401);
    expect((await f.app.request('/v1/memory?siteId=office', { headers: { ...headers, Origin: 'https://other.example' } })).status).toBe(403);
    vi.mocked(f.foundation.getSession).mockRejectedValueOnce(new DomainError('FORBIDDEN', 403, 'Access changed.'));
    expect((await f.app.request('/v1/memory?siteId=office', { headers })).status).toBe(403);
    expect(f.repository.list).not.toHaveBeenCalled();
  });
  it('preserves a short or empty filtered page with a next cursor', async () => {
    const f = fixture();vi.mocked(f.repository.list).mockResolvedValue({ scope, items: [], nextCursor: 'next' });
    const result = await f.app.request('/v1/memory?siteId=office&status=available&limit=10', { headers });
    expect(result.status).toBe(200);expect(await result.json()).toEqual({ scope, items: [], nextCursor: 'next' });
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(f.repository.list).toHaveBeenCalledWith(session.actor, { siteId: 'office', status: 'available', limit: 10 });
  });
  it.each(['siteId=office&siteId=other', 'siteId=office&organizationId=other', 'siteId=office&limit=51',
    'siteId=office&status=unknown', 'siteId=office&cursor=', 'limit=1'])('rejects malformed or duplicate selectors %s', async query => {
    const f = fixture();expect((await f.app.request('/v1/memory?' + query, { headers })).status).toBe(422);
    expect(f.repository.list).not.toHaveBeenCalled();
  });
  it('does not accept mismatched, duplicate, looping or removed-content page data', async () => {
    const f = fixture();
    for (const result of [{ scope: { ...scope, organizationId: 'foreign' }, items: [], nextCursor: null },
      { scope, items: [summary, summary], nextCursor: null }, { scope, items: [], nextCursor: 'same' },
      { scope, items: [{ ...summary, status: 'removed' as const }], nextCursor: null }]) {
      vi.mocked(f.repository.list).mockResolvedValueOnce(result);
      expect((await f.app.request('/v1/memory?siteId=office&cursor=same', { headers })).status).toBe(503);
    }
  });
  it('loads exactly one current note and rejects an alternate note or scope', async () => {
    const f = fixture();expect((await f.app.request('/v1/memory/note?siteId=office', { headers })).status).toBe(200);
    for (const result of [{ scope, note: { ...note, id: 'other' } }, { scope: { ...scope, siteId: 'foreign' }, note }]) {
      vi.mocked(f.repository.get).mockResolvedValueOnce(result);
      expect((await f.app.request('/v1/memory/note?siteId=office', { headers })).status).toBe(503);
    }
  });
  it.each(['/v1/memory/note', '/v1/memory/operations/memory_request_0001'])
  ('rejects added or duplicate selectors on %s', async path => {
    const f = fixture();
    for (const query of ['siteId=office&path=note', 'siteId=office&siteId=other', 'siteId=office&organizationId=other']) {
      expect((await f.app.request(`${path}?${query}`, { headers })).status).toBe(422);
    }
    expect(f.repository.get).not.toHaveBeenCalled(); expect(f.repository.recover).not.toHaveBeenCalled();
  });
  it('forwards one atomic remember request with the original key and no actor input', async () => {
    const f = fixture();const result = await f.app.request('/v1/memory', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(result.status).toBe(200);expect(await result.json()).toEqual(operation);
    expect(f.repository.command).toHaveBeenCalledExactlyOnceWith(session.actor, headers['Idempotency-Key'], input);
  });
  it.each([{ actorId: 'foreign' }, { sourceId: 'fabricated' }, { verified: true }, { title: ' ' }, { text: 'x'.repeat(8001) }])
  ('rejects private provenance and malformed input %#', async change => {
    const f = fixture();expect((await f.app.request('/v1/memory', { method: 'POST', headers, body: JSON.stringify({ ...input, ...change }) })).status).toBe(422);
    expect(f.repository.command).not.toHaveBeenCalled();
  });
  it('denies writes outside human operator/site authority', async () => {
    for (const actor of [{ ...session.actor, roles: ['auditor' as const] }, { ...session.actor, actionSiteIds: [] },
      { ...session.actor, siteIds: [] }, { ...session.actor, principalKind: 'service' as const }]) {
      const f = fixture({ ...session, actor });
      expect((await f.app.request('/v1/memory', { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(403);
      expect(f.repository.command).not.toHaveBeenCalled();
    }
  });
  it('retains exact edit token and remove meaning', async () => {
    const f = fixture();const command = { kind: 'remove', siteId: 'office', noteId: 'note', expected: note.editToken };
    vi.mocked(f.repository.command).mockResolvedValue({ ...operation, action: 'remove', current: { ...note, status: 'removed', title: 'Removed note',
      text: null, purpose: null, reviewBy: null, editToken: null } });
    expect((await f.app.request('/v1/memory', { method: 'POST', headers, body: JSON.stringify(command) })).status).toBe(200);
    expect(f.repository.command).toHaveBeenCalledExactlyOnceWith(session.actor, headers['Idempotency-Key'], command);
  });
  it('recovers the original operation without creating a second write', async () => {
    const f = fixture();const result = await f.app.request('/v1/memory/operations/memory_request_0001?siteId=office', { headers });
    expect(result.status).toBe(200);expect(await result.json()).toEqual({ operation });
    expect(f.repository.recover).toHaveBeenCalledExactlyOnceWith(session.actor, 'office', 'memory_request_0001');
    expect(f.repository.command).not.toHaveBeenCalled();expect(f.repository.get).not.toHaveBeenCalled();
    vi.mocked(f.repository.recover).mockResolvedValue(null);
    expect(await (await f.app.request('/v1/memory/operations/memory_request_0001?siteId=office', { headers })).json()).toEqual({ operation: null });
  });
  it('does not retry a lost write response or expose exception data', async () => {
    const f = fixture();vi.mocked(f.repository.command).mockRejectedValue(Error('private-connection-string'));
    const result = await f.app.request('/v1/memory', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(result.status).toBe(503);expect(await result.text()).not.toContain('private-connection-string');
    expect(f.repository.command).toHaveBeenCalledOnce();expect(f.repository.recover).not.toHaveBeenCalled();
  });
});
