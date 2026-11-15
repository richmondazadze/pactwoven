import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import { immutableMandate } from './mandate-capsule';
import { mandateRecoveryScope, type MandateRecovery, type MandateRecoveryScope } from './mandate-recovery';
import type { AuthoringLocator } from './mandate-authoring-recovery';

export type MandateWorkKind = 'document' | 'proposal' | 'AUTHORIZE' | 'REJECT' | 'PAUSE' | 'REVOKE' | 'RESUME';
export type MandateWork = { scope: MandateRecoveryScope; responsibilityId: string; targetId: string; kind: MandateWorkKind; key: string; phase: 'unsent' | 'pending' };
export type MandateWorkRequest = Omit<MandateWork, 'phase'> & { action: 'prepare' | 'send' | 'check' | 'retry'; hasHead?: boolean; eligible?: boolean };
export type MandateWorkSnapshot = { records: readonly MandateWork[]; blocked: boolean };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const stop = (kind: MandateWorkKind) => kind === 'PAUSE' || kind === 'REVOKE';
const authoring = (kind: MandateWorkKind) => kind === 'document' || kind === 'proposal';
const related = (a: MandateWork, b: MandateWorkRequest) => same(a.scope, b.scope) && a.responsibilityId === b.responsibilityId;
const original = (a: MandateWork, b: MandateWorkRequest) => related(a, b) && a.kind === b.kind && a.targetId === b.targetId && a.key === b.key;
export function authoringWork(locator: AuthoringLocator): MandateWork { return { scope: locator.scope, responsibilityId: locator.responsibilityId, targetId: locator.target.id, key: locator.key, kind: locator.step === 'proposal' ? 'proposal' : 'document', phase: 'pending' }; }
export function decisionWork(locator: MandateRecovery): MandateWork { return { scope: mandateRecoveryScope(locator), responsibilityId: locator.responsibilityId, targetId: locator.proposal.id, key: locator.key, kind: locator.kind === 'mandate.authorize' ? 'AUTHORIZE' : 'REJECT', phase: 'pending' }; }
// Local coordination never grants server authority. Stops still need a fresh, eligible head.
export function mandateWorkAllowed(request: MandateWorkRequest, snapshot: MandateWorkSnapshot): boolean {
  const records = snapshot.records.filter(record => related(record, request));
  if (request.action === 'check' || request.action === 'retry') return records.some(record => record.phase === 'pending' && original(record, request));
  if (stop(request.kind) && (!request.hasHead || !request.eligible)) return false;
  if (snapshot.blocked && !stop(request.kind)) return false;
  return !records.some(record => {
    if (record.phase === 'unsent') return !stop(request.kind) && (authoring(request.kind) || request.kind === 'AUTHORIZE' || request.kind === 'RESUME');
    if (record.kind === 'REVOKE' && (record.targetId === request.targetId || !stop(request.kind))) return true;
    if (stop(request.kind)) return record.kind === request.kind && record.targetId === request.targetId;
    if (authoring(record.kind) || record.kind === 'AUTHORIZE' || record.kind === 'REJECT') return authoring(request.kind) || request.kind === 'AUTHORIZE' || request.kind === 'RESUME';
    if (record.kind === 'RESUME') return request.kind === 'RESUME' || request.kind === 'AUTHORIZE' || authoring(request.kind);
    return record.kind === 'PAUSE' && (request.kind === 'RESUME' || request.kind === 'AUTHORIZE');
  });
}
export type MandateWorkTicket = Readonly<{ id: number; request: MandateWorkRequest }>;
export type MandateWorkTicketState = 'unsent' | 'dispatched';
export type MandateGrantInput = { scope: MandateRecoveryScope; responsibilityId: string; targetId: string; key: string; kind: 'AUTHORIZE' | 'RESUME'; integrityHash: string };
export type MandateGrantPreparation = Readonly<MandateGrantInput & { id: number; generation: number }>;
export function createMandateWorkCoordinator(snapshot: () => MandateWorkSnapshot) {
  let next = 0, ended = false;
  const active = new Map<number, { ticket: MandateWorkTicket; state: MandateWorkTicketState }>();
  const generations = new Map<string, number>(), preparations = new Map<number, { value: MandateGrantPreparation; ticket: MandateWorkTicket | null; listeners: Set<() => void> }>();
  const preparationScope = (scope: MandateRecoveryScope, responsibilityId: string) => canonicalJson([mandateRecoveryScope(scope), responsibilityId]);
  function fail(): never { throw new RequestError('MANDATE_WORK_CONFLICT', 'This original request or another related mandate operation needs checking before continuing.'); }
  function generation(scope: MandateRecoveryScope, responsibilityId: string) { if (ended) fail(); return generations.get(preparationScope(scope, responsibilityId)) ?? 0; }
  function preparationCurrent(value: MandateGrantPreparation) { const entry = preparations.get(value.id); return !ended && entry?.value === value && (!entry.ticket || state(entry.ticket) === 'unsent') && generation(value.scope, value.responsibilityId) === value.generation; }
  function registerPreparation(input: MandateGrantInput, expectedGeneration: number): MandateGrantPreparation {
    if (ended || generation(input.scope, input.responsibilityId) !== expectedGeneration || !mandateWorkAllowed({ ...input, action: 'prepare' }, snapshot())) fail();
    const value = immutableMandate({ ...structuredClone(input), scope: mandateRecoveryScope(input.scope), id: ++next, generation: expectedGeneration });
    preparations.set(value.id, { value, ticket: null, listeners: new Set() }); return value;
  }
  function watchPreparation(value: MandateGrantPreparation, listener: () => void) {
    if (!preparationCurrent(value)) { listener(); return () => {}; }
    const entry = preparations.get(value.id)!; entry.listeners.add(listener); return () => { entry.listeners.delete(listener); };
  }
  function bindPreparation(value: MandateGrantPreparation, ticket: MandateWorkTicket) {
    if (!preparationCurrent(value) || ticket.request.action !== 'send' || !original({ ...value, phase: 'unsent' }, ticket.request)) fail();
    assert(ticket); const entry = preparations.get(value.id)!; if (entry.ticket) fail(); entry.ticket = ticket;
  }
  function releasePreparation(value: MandateGrantPreparation) { if (preparations.get(value.id)?.value === value) preparations.delete(value.id); }
  function invalidatePreparations(request: MandateWorkRequest) {
    const key = preparationScope(request.scope, request.responsibilityId); generations.set(key, (generations.get(key) ?? 0) + 1);
    const listeners: (() => void)[] = [];
    for (const [id, entry] of preparations) {
      if (preparationScope(entry.value.scope, entry.value.responsibilityId) !== key || (entry.ticket && state(entry.ticket) === 'dispatched')) continue;
      preparations.delete(id); listeners.push(...entry.listeners);
    }
    // Revoke all identities before notifying React callers; no listener may restore
    // a stale generation. Notifications never dispatch or erase durable originals.
    for (const listener of listeners) { try { listener(); } catch { /* Revoked identities stay revoked even if a view notification fails. */ } }
  }
  function acquire(input: MandateWorkRequest): MandateWorkTicket {
    const request = immutableMandate(structuredClone(input));
    if (ended || !mandateWorkAllowed(request, snapshot())) fail();
    const invalidated: number[] = [];
    for (const entry of active.values()) {
      const work = { ...entry.ticket.request, phase: 'pending' as const };
      if (original(work, request)) fail();
      if (!related(work, request)) continue;
      // Original checks/retries recover an earlier durable attempt, even before this read/retry
      // is dispatched. They are not a new grant preparation and remain reachable beside stops.
      if (request.action === 'check' || request.action === 'retry') continue;
      if (stop(request.kind) && !stop(work.kind)) {
        if (entry.state === 'unsent' && (work.action === 'prepare' || work.action === 'send') && (work.kind === 'AUTHORIZE' || work.kind === 'RESUME')) invalidated.push(entry.ticket.id);
        continue;
      }
      if (request.kind !== 'REVOKE' || work.kind !== 'PAUSE') fail();
    }
    // A rejected stop acquisition never invalidates another owner.
    for (const id of invalidated) active.delete(id);
    const ticket = Object.freeze({ id: ++next, request }); active.set(ticket.id, { ticket, state: 'unsent' });
    if (stop(request.kind) && request.action === 'send') invalidatePreparations(request);
    return ticket;
  }
  function assert(ticket: MandateWorkTicket) {
    const entry = active.get(ticket.id);
    if (ended || entry?.ticket !== ticket) fail();
    // Later local work cannot cancel a dispatched operation. Its response is historical;
    // transport scope and exact receipt/locator checks still apply separately.
    if (entry.state === 'dispatched') return;
    const current = snapshot(), request = ticket.request;
    const records = request.action === 'send' || request.action === 'prepare' ? current.records.filter(record => !original(record, request)) : current.records;
    if (!mandateWorkAllowed(request, { ...current, records })) fail();
  }
  function markDispatched(ticket: MandateWorkTicket) {
    assert(ticket);
    const entry = active.get(ticket.id)!;
    if (entry.state !== 'unsent' || (ticket.request.action !== 'send' && ticket.request.action !== 'retry')) fail();
    entry.state = 'dispatched';
    for (const [id, preparation] of preparations) if (preparation.ticket === ticket) preparations.delete(id);
  }
  function state(ticket: MandateWorkTicket): MandateWorkTicketState | null { const entry = active.get(ticket.id); return entry?.ticket === ticket ? entry.state : null; }
  function release(ticket: MandateWorkTicket) { if (active.get(ticket.id)?.ticket === ticket) { active.delete(ticket.id); for (const entry of preparations.values()) if (entry.ticket === ticket) entry.ticket = null; } }
  // Revoking client ownership never deletes a durable locator or cancels server work.
  function clear() { ended = true; active.clear(); preparations.clear(); generations.clear(); }
  return { acquire, assert, markDispatched, state, release, clear, generation, registerPreparation, preparationCurrent, watchPreparation, bindPreparation, releasePreparation };
}
export type MandateWorkCoordinator = ReturnType<typeof createMandateWorkCoordinator>;
