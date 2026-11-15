import { describe, expect, it, vi } from 'vitest';
import type { MandateGateway } from '@pactwoven/contracts';
import type { MandateRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';
import { createMandateGateway } from './mandate-service.js';
import { qualifyMandateDocumentResult } from './mandate-document-result.js';
import { handlePrivateMandateRequest, serviceMandateGateway } from './worker-mandate.js';
import { documentReadFixture } from './mandate-document.test-fixtures.js';

const route = '/v1/responsibilities/responsibility_a/mandate-policy-documents/policy_a';
const issuer = 'https://fixture.clerk.accounts.dev', token = 'synthetic-document-token';
const identity: VerifiedIdentity = { subject: 'owner_a', externalOrganizationId: 'external_a', externalMembershipId: 'member_a', externalOrganizationName: 'Fixture',
  externalRole: 'org:admin', sessionId: 'session_a', authenticatedAt: '2026-11-15T07:00:00.000Z', membershipObservedAt: new Date().toISOString() };
async function setup() {
  const value = await documentReadFixture();
  const repository = { readDocument: vi.fn(async () => structuredClone(value)), list: vi.fn(), review: vi.fn(), operation: vi.fn(), requester: vi.fn(), mutate: vi.fn() } satisfies MandateRepository;
  const verifyIdentity = vi.fn(async () => identity), verifyMandateStepUp = vi.fn(), directory = { resolve: vi.fn() };
  const gateway = createMandateGateway({ repository, verifyIdentity, verifyMandateStepUp, directory });
  const app = createApp({ allowedOrigins: ['https://web.example'], verifyIdentity, mandateGateway: gateway });
  return { value, repository, verifyIdentity, verifyMandateStepUp, directory, gateway, app };
}
function adapter(gateway: MandateGateway, suffix = '?version=1', method = 'GET', transform?: (data: any) => void) {
  const wires: unknown[] = [];
  const fetch = vi.fn(async (request: Request) => {
    wires.push(await request.clone().json());
    const response = await handlePrivateMandateRequest(request, issuer, () => gateway);
    if (!transform) return response;
    const data = await response.json(); transform(data);
    return Response.json(data, { status: response.status, headers: response.headers });
  });
  return { fetch, wires, gateway: serviceMandateGateway({ fetch }, new Request(`https://api.example${route}${suffix}`, { method, headers: { Authorization: `Bearer ${token}` } }), issuer) };
}
describe('exact document read transport', () => {
  it('returns complete historical text and original save receipt using current identity only', async () => {
    const f = await setup();
    const response = await f.app.request(`${route}?version=1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(f.value);
    expect(f.repository.readDocument).toHaveBeenCalledExactlyOnceWith(identity, 'responsibility_a', 'policy_a', { version: 1 }, expect.any(String));
    expect(f.repository.mutate).not.toHaveBeenCalled(); expect(f.repository.requester).not.toHaveBeenCalled();
    expect(f.verifyMandateStepUp).not.toHaveBeenCalled(); expect(f.directory.resolve).not.toHaveBeenCalled();
  });
  it.each(['', '?version=0', '?version=01', '?version=2147483648', '?version=1&version=1', '?version=1&latest=true', '?version=1&hash=x'])('rejects noncanonical public query %s', async suffix => {
    const f = await setup(); expect((await f.app.request(`${route}${suffix}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(422);
    expect(f.repository.readDocument).not.toHaveBeenCalled(); expect(f.repository.mutate).not.toHaveBeenCalled();
  });
  it('has no unauthenticated read and propagates current-access denial without a save or MFA', async () => {
    const f = await setup(); expect((await f.app.request(`${route}?version=1`)).status).toBe(401);
    f.repository.readDocument.mockRejectedValue(new DomainError('FORBIDDEN', 403, 'No current read access'));
    const response = await f.app.request(`${route}?version=1`, { headers: { Authorization: `Bearer ${token}` } }); expect(response.status).toBe(403);
    expect(f.repository.mutate).not.toHaveBeenCalled(); expect(f.verifyMandateStepUp).not.toHaveBeenCalled();
  });
  it('binds the exact document/read version and original bearer across private transport with no mutation key', async () => {
    const f = await setup(), a = adapter(f.gateway);
    expect(await a.gateway.readDocument(token, 'responsibility_a', 'policy_a', { version: 1 }, 'trace')).toEqual(f.value);
    const wire = a.wires[0] as { action: unknown };
    expect(wire.action).toEqual({ kind: 'document-read', responsibilityId: 'responsibility_a', documentId: 'policy_a', query: { version: 1 } });
    expect(a.fetch.mock.calls[0]![0].headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(wire.action).not.toHaveProperty('key'); expect(f.verifyIdentity).toHaveBeenCalledExactlyOnceWith(token);
    expect(f.repository.mutate).not.toHaveBeenCalled(); expect(f.verifyMandateStepUp).not.toHaveBeenCalled();
  });
  it('rejects route, version, method and duplicate query mismatch before private dispatch', async () => {
    const f = await setup();
    for (const [suffix, method] of [['?version=2', 'GET'], ['?version=1&version=1', 'GET'], ['?version=1&extra=x', 'GET'], ['?version=1', 'POST']]) {
      const a = adapter(f.gateway, suffix, method);
      await expect(a.gateway.readDocument(token, 'responsibility_a', 'policy_a', { version: 1 }, 'trace')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      expect(a.fetch).not.toHaveBeenCalled();
    }
    const a = adapter(f.gateway);
    await expect(a.gateway.readDocument(token, 'responsibility_a', 'foreign_document', { version: 1 }, 'trace')).rejects.toThrow(); expect(a.fetch).not.toHaveBeenCalled();
  });
  it('rejects changed response affinity and does not turn private error data into a document', async () => {
    const f = await setup();
    for (const change of [(d: any) => { d.targetId = 'foreign_document'; }, (d: any) => { d.kind = 'document'; },
      (d: any) => { d.request.url += '&extra=1'; }, (d: any) => { d.outcome.data.document.text = 'Changed'; }]) {
      const a = adapter(f.gateway, '?version=1', 'GET', change);
      await expect(a.gateway.readDocument(token, 'responsibility_a', 'policy_a', { version: 1 }, 'trace')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
    f.repository.readDocument.mockRejectedValue(new DomainError('NOT_FOUND', 404, 'PRIVATE_DETAIL'));
    await expect(adapter(f.gateway).gateway.readDocument(token, 'responsibility_a', 'policy_a', { version: 1 }, 'trace')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'The requested mandate record was not found.' });
  });
  it('recomputes text/full hashes and historical snapshot hash beyond structural validation', async () => {
    const original = await documentReadFixture();
    for (const change of [(v: any) => { v.document.text = 'Changed text'; }, (v: any) => { v.document.contentHash = 'b'.repeat(64); },
      (v: any) => { v.document.hash = 'b'.repeat(64); v.saveOperation.target.hash = 'b'.repeat(64); },
      (v: any) => { v.savedResponsibility.title = 'Changed title'; }, (v: any) => { v.savedAgainst.responsibility.hash = 'b'.repeat(64); },
      (v: any) => { v.saveOperation.operation.id = ''; }, (v: any) => { v.document.version = 2; }]) {
      const value = structuredClone(original); change(value);
      await expect(qualifyMandateDocumentResult(value, 'responsibility_a', 'policy_a', { version: 1 }, 'development')).rejects.toMatchObject({ code: 'INTEGRITY_ERROR', status: 503 });
    }
    await expect(qualifyMandateDocumentResult(original, 'responsibility_a', 'policy_a', { version: 1 }, 'staging')).rejects.toMatchObject({ code: 'INTEGRITY_ERROR' });
    await expect(qualifyMandateDocumentResult(original, 'responsibility_a', 'policy_a', { version: 2 })).rejects.toMatchObject({ code: 'INTEGRITY_ERROR' });
  });
});
