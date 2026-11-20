import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import type { NativeWorkConversation, NativeWorkConversationRepository, NativeWorkInstructionReceipt } from '../../../packages/contracts/src/native-work-conversation';
import { createApp } from './app';

const at = '2026-11-19T07:00:00.000Z', origin = 'https://pactwoven.vercel.app', key = 'original_instruction_001';
const headers = { Authorization: 'Bearer synthetic', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key };
const input = { text: 'Use a remote format with two breaks.', expectedInstructionVersion: 0, expectedControlVersion: 2 };
function fixture() {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office', 'warehouse'], actionSiteIds: ['office', 'warehouse'], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
  const identity: VerifiedIdentity = { subject: 'external', externalOrganizationId: 'org_external', sessionId: 'session', externalOrganizationName: 'Company',
    externalMembershipId: 'member', externalRole: 'org:admin', authenticatedAt: at, membershipObservedAt: at };
  const scope = { environment: 'development' as const, organizationId: 'org', siteId: 'office' };
  const conversation: NativeWorkConversation = { scope, rootTaskId: 'root', instructionVersion: 0, controlVersion: 2,
    originalPrompt: 'Plan a four-hour fictional workshop.', entries: [], canUpdate: true, updateUnavailableReason: null };
  const receipt: NativeWorkInstructionReceipt = { scope, rootTaskId: 'root', requestKey: key, instructionVersion: 1, controlVersion: 3,
    entry: { sequence: 1, text: input.text, recordedAt: at, state: 'recorded' }, committedAt: at, state: 'paused' };
  const repository: NativeWorkConversationRepository = { read: vi.fn(async () => conversation), update: vi.fn(async () => receipt),
    recover: vi.fn(async () => ({ scope, rootTaskId: 'root', requestKey: key, operation: receipt })) };
  const foundation: FoundationRepository = { getSession: vi.fn(async () => session), listResponsibilities: vi.fn(), getResponsibility: vi.fn(), createResponsibility: vi.fn() };
  const verifyIdentity = vi.fn(async () => identity);
  const app = createApp({ allowedOrigins: [origin], repository: foundation, verifyIdentity, nativeWorkConversationRepository: repository }, { surface: 'native' });
  const get = (suffix = '?siteId=office') => app.request('/v1/agent-work/root/conversation' + suffix, { headers });
  const update = (body: unknown = input, suffix = '?siteId=office') => app.request('/v1/agent-work/root/instructions' + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  const recover = () => app.request('/v1/agent-work/root/instructions/' + key + '?siteId=office', { headers });
  return { app, get, update, recover, repository, foundation, verifyIdentity, session, scope, conversation, receipt };
}
describe('same-root instruction HTTP boundary', () => {
  it('returns the ordered saved conversation with private caching', async () => {
    const f = fixture(), r = await f.get(); expect(r.status).toBe(200); expect(await r.json()).toEqual(f.conversation);
    expect(f.repository.read).toHaveBeenCalledExactlyOnceWith(f.session.actor, 'root', 'office');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });
  it('commits exactly one bound paused instruction and exposes no worker selectors', async () => {
    const f = fixture(), r = await f.update(); expect(r.status).toBe(200); expect(await r.json()).toEqual(f.receipt);
    expect(f.repository.update).toHaveBeenCalledExactlyOnceWith(f.session.actor, 'root', 'office', key, input);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('recovers the exact original receipt without another write', async () => {
    const f = fixture(), r = await f.recover(); expect(r.status).toBe(200); expect((await r.json()).operation).toEqual(f.receipt);
    expect(f.repository.recover).toHaveBeenCalledExactlyOnceWith(f.session.actor, 'root', 'office', key);
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('returns scoped null recovery without inventing a saved instruction', async () => {
    const f = fixture(); vi.mocked(f.repository.recover).mockResolvedValueOnce({ scope: f.scope, rootTaskId: 'root', requestKey: key, operation: null });
    expect((await (await f.recover()).json()).operation).toBeNull();
  });
  it.each(['?siteId=office&siteId=warehouse', '?siteId=office&actorId=other', '?siteId=absent', ''])('rejects invalid or inaccessible selector %s', async suffix => {
    const f = fixture(); expect([403, 422]).toContain((await f.update(input, suffix)).status); expect(f.repository.update).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, rootTaskId: 'another' }, { ...input, siteId: 'warehouse' }, { ...input, grant: {} },
    { ...input, expectedInstructionVersion: 16 }, { ...input, expectedControlVersion: 0 }, { ...input, text: ' ' },
  ])('rejects a substituted or invalid command %#', async body => {
    const f = fixture(); expect((await f.update(body)).status).toBe(422); expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('parses a strict body before identity and never resolves duplicate CAS fields', async () => {
    const f = fixture(); const r = await f.app.request('/v1/agent-work/root/instructions?siteId=office', { method: 'POST', headers,
      body: '{"text":"changed","expectedInstructionVersion":0,"expectedControlVersion":2,"expectedControlVersion":3}' });
    expect(r.status).toBe(422); expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('blocks unsigned and foreign-origin requests before repository calls', async () => {
    const f = fixture();
    expect((await f.app.request('/v1/agent-work/root/conversation?siteId=office')).status).toBe(401);
    expect((await f.app.request('/v1/agent-work/root/conversation?siteId=office', { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status).toBe(403);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('retains read-only recovery while removing the update affordance and refusing writes', async () => {
    const f = fixture(); f.session.actor.roles = ['auditor']; f.session.actor.actionSiteIds = [];
    const read = await f.get(); expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ canUpdate: false, updateUnavailableReason: 'authority_unavailable' });
    expect((await f.update()).status).toBe(403); expect((await f.recover()).status).toBe(200); expect(f.repository.update).not.toHaveBeenCalled();
  });
  it.each(['siteId', 'organizationId', 'environment', 'rootTaskId'])('rejects cross-boundary stored %s data', async field => {
    const f = fixture();
    if (field === 'rootTaskId') f.receipt.rootTaskId = 'other';
    else (f.receipt.scope as Record<string, string>)[field] = field === 'environment' ? 'production' : 'other';
    expect((await f.update()).status).toBe(503);
  });
  it.each(['requestKey', 'instructionVersion', 'controlVersion', 'text'])('does not accept a receipt for a different %s', async field => {
    const f = fixture();
    if (field === 'text') f.receipt.entry.text = 'another';
    if (field === 'requestKey') f.receipt.requestKey = 'different_instruction_key';
    if (field === 'instructionVersion') { f.receipt.instructionVersion = 2; f.receipt.entry.sequence = 2; }
    if (field === 'controlVersion') f.receipt.controlVersion = 4;
    expect((await f.update()).status).toBe(503); expect(f.repository.update).toHaveBeenCalledOnce();
  });
  it('rejects incomplete instruction history or a fabricated recovery binding', async () => {
    const f = fixture(); f.conversation.instructionVersion = 1; expect((await f.get()).status).toBe(503);
    vi.mocked(f.repository.recover).mockResolvedValueOnce({ scope: f.scope, rootTaskId: 'root', requestKey: key, operation: { ...f.receipt, requestKey: 'other_request_key' } });
    expect((await f.recover()).status).toBe(503);
  });
  it('preserves definite version conflicts and uncertain writes without retrying', async () => {
    const f = fixture(); vi.mocked(f.repository.update).mockRejectedValueOnce(new DomainError('ROOT_CONFLICT', 409, 'The work changed.'));
    expect((await f.update()).status).toBe(409);
    vi.mocked(f.repository.update).mockRejectedValueOnce(Error('private_database_connection'));
    const r = await f.update(); expect(r.status).toBe(503); expect(await r.text()).not.toContain('private_database_connection');
    expect(f.repository.update).toHaveBeenCalledTimes(2); expect(f.repository.recover).not.toHaveBeenCalled();
  });
});
