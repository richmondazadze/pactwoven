import { describe, expect, it } from 'vitest';
import { createMandateWorkCoordinator, decisionWork, mandateWorkAllowed, type MandateWork, type MandateWorkKind, type MandateWorkRequest } from './mandate-work-coordination';
import { decisionTestCase } from './mandates.test-fixtures';
const scope = { userId: 'user_a', externalOrganizationId: 'provider_org_a', apiBase: 'https://api.example.test', organizationId: 'org_a', environment: 'development' as const, actorId: 'actor_a' };
const pending = (kind: MandateWorkKind): MandateWork => ({ scope, responsibilityId: 'responsibility_a', targetId: 'target_a', key: 'original_request_123456', kind, phase: 'pending' });
const request = (kind: MandateWorkKind): MandateWorkRequest => ({ ...pending(kind), key: 'new_request_123456789', action: 'send', hasHead: true, eligible: true });
describe('kind and target mandate coordination', () => {
  it.each(['document', 'proposal', 'AUTHORIZE', 'REJECT', 'RESUME'] as const)('retains eligible stops during unknown %s', kind => { const snapshot = { blocked: false, records: [pending(kind)] }; expect(mandateWorkAllowed(request('PAUSE'), snapshot)).toBe(true); expect(mandateWorkAllowed(request('REVOKE'), snapshot)).toBe(true); });
  it.each(['document', 'proposal', 'AUTHORIZE', 'RESUME'] as const)('blocks new %s while a document, proposal or C1 decision is unknown', kind => { for (const existing of ['document', 'proposal', 'AUTHORIZE', 'REJECT'] as const) expect(mandateWorkAllowed(request(kind), { blocked: false, records: [pending(existing)] })).toBe(false); });
  it('permits revoke during unknown pause, blocking duplicate pause', () => { const snapshot = { blocked: false, records: [pending('PAUSE')] }; expect(mandateWorkAllowed(request('PAUSE'), snapshot)).toBe(false); expect(mandateWorkAllowed(request('REVOKE'), snapshot)).toBe(true); });
  it.each(['AUTHORIZE', 'RESUME', 'PAUSE', 'REVOKE', 'document', 'proposal'] as const)('blocks replacement %s behind unknown revoke', kind => expect(mandateWorkAllowed(request(kind), { blocked: false, records: [pending('REVOKE')] })).toBe(false));
  it('requires a real eligible accepted head even while authorization is unknown', () => { const snapshot = { blocked: false, records: [pending('AUTHORIZE')] }; expect(mandateWorkAllowed({ ...request('PAUSE'), hasHead: false }, snapshot)).toBe(false); expect(mandateWorkAllowed({ ...request('REVOKE'), eligible: false }, snapshot)).toBe(false); });
  it('never globally blocks an unrelated responsibility or actor stop', () => { const other = { ...pending('REVOKE'), responsibilityId: 'other_responsibility' }; expect(mandateWorkAllowed(request('REVOKE'), { blocked: false, records: [other] })).toBe(true); expect(mandateWorkAllowed(request('REVOKE'), { blocked: false, records: [{ ...pending('REVOKE'), scope: { ...scope, actorId: 'other_actor' } }] })).toBe(true); });
  it('keeps only original check/retry reachable across conflicting pending commands', () => { const old = pending('RESUME'), snapshot = { blocked: true, records: [old, pending('REVOKE')] }; expect(mandateWorkAllowed({ ...old, action: 'check' }, snapshot)).toBe(true); expect(mandateWorkAllowed({ ...old, action: 'retry' }, snapshot)).toBe(true); expect(mandateWorkAllowed({ ...request('RESUME'), action: 'retry' }, snapshot)).toBe(false); });
  it('accepts stops during unsent verification without treating them as automatic effects', () => { const record = { ...pending('AUTHORIZE'), phase: 'unsent' as const }; expect(mandateWorkAllowed(request('PAUSE'), { blocked: false, records: [record] })).toBe(true); expect(record.phase).toBe('unsent'); });
  it.each([['AUTHORIZE', 'PAUSE'], ['AUTHORIZE', 'REVOKE'], ['RESUME', 'PAUSE'], ['RESUME', 'REVOKE']] as const)('unsent %s ownership is invalidated by %s without a dispatch', (kind, stopKind) => {
    const coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [] })), grant = coordinator.acquire(request(kind)); expect(coordinator.state(grant)).toBe('unsent');
    const stop = coordinator.acquire(request(stopKind)); expect(coordinator.state(grant)).toBeNull(); expect(() => coordinator.assert(grant)).toThrow(); expect(() => coordinator.markDispatched(grant)).toThrow(); coordinator.assert(stop); coordinator.release(grant); coordinator.assert(stop);
  });
  it.each(['AUTHORIZE', 'RESUME'] as const)('preserves already dispatched %s ownership and original recovery alongside a stop', kind => {
    const records: MandateWork[] = [], coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records })), grant = coordinator.acquire(request(kind));
    records.push({ ...grant.request, phase: 'pending' }); coordinator.markDispatched(grant); expect(coordinator.state(grant)).toBe('dispatched');
    const stop = coordinator.acquire(request('REVOKE')); records.push({ ...stop.request, phase: 'pending' }); coordinator.assert(grant); coordinator.assert(stop); expect(records).toHaveLength(2);
    coordinator.release(grant); const read = coordinator.acquire({ ...grant.request, action: 'check' }); coordinator.assert(read); coordinator.release(read);
    const retry = coordinator.acquire({ ...grant.request, action: 'retry' }); coordinator.assert(retry); coordinator.markDispatched(retry); coordinator.assert(retry); expect(records[0]?.key).toBe(grant.request.key);
  });
  it.each(['check', 'retry'] as const)('preserves retained-original %s ownership when the stop is acquired second', action => {
    const old = pending('AUTHORIZE'), coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [old] })), recovery = coordinator.acquire({ ...old, action }), stop = coordinator.acquire(request('PAUSE')); coordinator.assert(recovery); coordinator.assert(stop);
  });
  it('invalidates a grant preparation ticket before factor verification can become a send', () => {
    const coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [] })), preparation = coordinator.acquire({ ...request('AUTHORIZE'), action: 'prepare' });
    const stop = coordinator.acquire(request('PAUSE')); expect(() => coordinator.assert(preparation)).toThrow(); coordinator.assert(stop);
  });
  it('does not invalidate an unrelated unsent grant or invalidate anything for a rejected stop', () => {
    const coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [] })), grant = coordinator.acquire(request('AUTHORIZE'));
    expect(() => coordinator.acquire({ ...request('PAUSE'), eligible: false })).toThrow(); coordinator.assert(grant);
    const other = coordinator.acquire({ ...request('REVOKE'), responsibilityId: 'other_responsibility' }); coordinator.assert(grant); coordinator.assert(other);
  });
  it('does not grant dispatch state to a read, released ticket or repeated mark', () => {
    const old = pending('RESUME'), coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [old] })), read = coordinator.acquire({ ...old, action: 'check' }); expect(() => coordinator.markDispatched(read)).toThrow(); coordinator.release(read); expect(coordinator.state(read)).toBeNull();
    const retry = coordinator.acquire({ ...old, action: 'retry' }); coordinator.markDispatched(retry); expect(() => coordinator.markDispatched(retry)).toThrow();
  });
  it('an old ticket cannot release or revive a newer request, including after scope teardown', () => { const coordinator = createMandateWorkCoordinator(() => ({ blocked: false, records: [] })), old = coordinator.acquire(request('document')); coordinator.release(old); const current = coordinator.acquire(request('document')); coordinator.release(old); coordinator.assert(current); expect(() => coordinator.assert(old)).toThrow(); coordinator.clear(); expect(() => coordinator.assert(current)).toThrow(); expect(() => coordinator.acquire(request('document'))).toThrow(); });
  it('rechecks pending conflicts at the final ownership boundary', () => { const snapshot: { blocked: boolean; records: MandateWork[] } = { blocked: false, records: [] }, coordinator = createMandateWorkCoordinator(() => snapshot), ticket = coordinator.acquire(request('document')); snapshot.records.push(pending('AUTHORIZE')); expect(() => coordinator.assert(ticket)).toThrow(); });
  it('preserves exact original C1 scope and identity without changing its schema', async () => { const f = await decisionTestCase(), work = decisionWork(f.locator); expect(work.kind).toBe('REJECT'); expect(work.targetId).toBe(f.locator.proposal.id); expect(work.key).toBe(f.locator.key); expect(work.scope).not.toHaveProperty('sessionId'); expect(f.locator).not.toHaveProperty('phase'); });
});
