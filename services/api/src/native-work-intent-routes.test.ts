import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import type { NativeWorkIntentRepository, NativeWorkIntentOperation, NativeWorkIntentReview } from '../../../packages/contracts/src/native-work-intent';
import type { ClerkIdentityObservation } from './auth.js';
import { createApp } from './app.js';

const origin = 'https://pactwoven.vercel.app', key = 'original_work_intent_001';
const headers = { Authorization: 'Bearer synthetic-token', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key };
function fixture(observed = true) {
  const now = Date.now(), at = new Date(now).toISOString();
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office'], actionSiteIds: ['office'], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
  const identity: VerifiedIdentity = { subject: 'external', externalOrganizationId: 'org_external', sessionId: 'session',
    externalOrganizationName: 'Company', externalMembershipId: 'member', externalRole: 'org:admin', authenticatedAt: at, membershipObservedAt: at };
  const observation: ClerkIdentityObservation = { identity, observation: { issuer: 'https://pactwoven.clerk.accounts.dev', tokenHash: 'a'.repeat(64),
    tokenIssuedAt: at, observedAt: at, expiresAt: new Date(now + 60_000).toISOString() } };
  const scope = { environment: 'development' as const, organizationId: 'org', siteId: 'office' };
  const review: NativeWorkIntentReview = { id: 'review', token: 'b'.repeat(64), preparedAt: at, confirmBy: new Date(now + 300_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(), body: { title: 'Workshop plan', prompt: 'Prepare workshop advice.', siteName: 'Office',
      selectedNotes: [], allowedWork: ['Research public sources', 'Draft advice'], continuesAfterSignOut: true, externalEffects: 'forbidden' } };
  const operation: NativeWorkIntentOperation = { scope, id: 'operation', reviewId: review.id, rootTaskId: 'root_task', title: review.body.title,
    committedAt: at, expiresAt: review.expiresAt, continuesAfterSignOut: true, kind: 'delegated_advice' };
  const repository: NativeWorkIntentRepository = { prepare: vi.fn(async () => ({ scope, review, operation: null })),
    confirm: vi.fn(async () => operation), recover: vi.fn(async () => ({ scope, review, operation, reviewUnavailable: false })), provenance: vi.fn() };
  const foundation: FoundationRepository = { getSession: vi.fn(async () => session), listResponsibilities: vi.fn(), getResponsibility: vi.fn(), createResponsibility: vi.fn() };
  const verify = vi.fn(async () => observation), ordinary = vi.fn(async () => identity);
  const app = createApp({ allowedOrigins: [origin], repository: foundation, nativeWorkIntentRepository: repository,
    ...(observed ? { verifyObservedIdentity: verify } : { verifyIdentity: ordinary }) }, { surface: 'native' });
  const prepare = { siteId: 'office', title: review.body.title, prompt: review.body.prompt, selections: [], continuesAfterSignOut: true };
  const confirm = { reviewId: review.id, reviewToken: review.token, continuesAfterSignOut: true };
  const post = (path: string, body: unknown, custom = headers) => app.request('/v1/agent-work/' + path,
    { method: 'POST', headers: custom, body: JSON.stringify(body) });
  return { app, post, prepare, confirm, review, operation, scope, repository, foundation, session, observation, verify, ordinary };
}
describe('authenticated human work-intent HTTP boundary', () => {
  it('prepares the exact user input under one current observed identity', async () => {
    const f = fixture(), response = await f.post('prepare', f.prepare);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ scope: f.scope, review: f.review, operation: null });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith('synthetic-token'); expect(f.ordinary).not.toHaveBeenCalled();
    expect(f.repository.prepare).toHaveBeenCalledWith(f.session.actor, key, f.prepare);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('confirms with server observation only and returns no provider or grant material', async () => {
    const f = fixture(), response = await f.post('confirm', f.confirm);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(f.operation);
    expect(f.repository.confirm).toHaveBeenCalledWith(f.session.actor, key, f.confirm, {
      providerIssuer: f.observation.observation.issuer, sessionVerifiedAt: f.observation.observation.observedAt,
      sessionExpiresAt: f.observation.observation.expiresAt });
  });
  it('never treats an ordinary identity lookup as fresh issuance evidence', async () => {
    const f = fixture(false); expect((await f.post('confirm', f.confirm)).status).toBe(503);
    expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it.each(['scope', 'observation', 'service', 'limits', 'providerIssuer'])('rejects browser-supplied authority material %s', async field => {
    const f = fixture(); expect((await f.post('confirm', { ...f.confirm, [field]: {} })).status).toBe(422);
    expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it.each(['expired', 'old', 'future', 'session'])('rejects %s observer evidence before confirmation', async kind => {
    const f = fixture();
    if (kind === 'expired') f.observation.observation.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'old') f.observation.observation.observedAt = new Date(Date.now() - 21_000).toISOString();
    if (kind === 'future') f.observation.observation.observedAt = new Date(Date.now() + 60_000).toISOString();
    if (kind === 'session') f.observation.identity.sessionId = 'foreign_session';
    expect([401, 503]).toContain((await f.post('confirm', f.confirm)).status); expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it('rejects unauthorized origins and missing tokens before the observer or database', async () => {
    const f = fixture();
    expect((await f.post('prepare', f.prepare, { ...headers, Authorization: '' })).status).toBe(401);
    expect((await f.post('prepare', f.prepare, { ...headers, Origin: 'https://foreign.invalid' })).status).toBe(403);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.repository.prepare).not.toHaveBeenCalled();
  });
  it('finishes bounded upload parsing before live observation', async () => {
    const f = fixture();
    expect((await f.app.request('/v1/agent-work/prepare', { method: 'POST', headers, body: JSON.stringify({ prompt: 'x'.repeat(70_000) }) })).status).toBe(413);
    expect(f.verify).not.toHaveBeenCalled();
    expect((await f.app.request('/v1/agent-work/prepare', { method: 'POST', headers, body: '{' })).status).toBe(422);
    expect(f.verify).not.toHaveBeenCalled();
  });
  it('returns unknown rather than a definite rejection for misbound committed output', async () => {
    const f = fixture();vi.mocked(f.repository.confirm).mockResolvedValueOnce({ ...f.operation, scope: { ...f.scope, siteId: 'another' } });
    const response = await f.post('confirm', f.confirm); expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('DURABLE_SERVICE_UNAVAILABLE');
  });
  it('keeps recovery readable without write authority and rejects duplicate scope selectors', async () => {
    const f = fixture();f.session.actor.roles = ['auditor'];f.session.actor.actionSiteIds = [];
    expect((await f.app.request('/v1/agent-work/operations/' + key + '?siteId=office', { headers })).status).toBe(200);
    expect((await f.app.request('/v1/agent-work/operations/' + key + '?siteId=office&siteId=another', { headers })).status).toBe(422);
    expect((await f.post('prepare', f.prepare)).status).toBe(403);
    expect(f.repository.prepare).not.toHaveBeenCalled();
  });
  it('rejects substituted review text, duplicated selections, or mismatched recovered operations', async () => {
    const f = fixture();vi.mocked(f.repository.prepare).mockResolvedValueOnce({ scope: f.scope, review: { ...f.review, body: { ...f.review.body, prompt: 'Different intent' } }, operation: null });
    expect((await f.post('prepare', f.prepare)).status).toBe(503);
    expect((await f.post('prepare', { ...f.prepare, selections: [{ noteId: 'one', expected: 'a'.repeat(64) }, { noteId: 'one', expected: 'b'.repeat(64) }] })).status).toBe(422);
    vi.mocked(f.repository.recover).mockResolvedValueOnce({ scope: f.scope, review: f.review, operation: { ...f.operation, reviewId: 'different_review' }, reviewUnavailable: false });
    expect((await f.app.request('/v1/agent-work/operations/' + key + '?siteId=office', { headers })).status).toBe(503);
  });
  it('returns the original operation without withheld review content after access changes', async () => {
    const f = fixture();
    vi.mocked(f.repository.recover).mockResolvedValueOnce({ scope: f.scope, review: null, operation: f.operation, reviewUnavailable: true });
    const response = await f.app.request('/v1/agent-work/operations/' + key + '?siteId=office', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope: f.scope, review: null, operation: f.operation, reviewUnavailable: true });
    expect(f.repository.confirm).not.toHaveBeenCalled(); expect(f.repository.prepare).not.toHaveBeenCalled();
  });
});
