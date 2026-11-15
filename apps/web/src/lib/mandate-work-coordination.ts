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
export function createMandateWorkCoordinator(snapshot: () => MandateWorkSnapshot) {
  let next = 0, ended = false;
  const active = new Map<number, { ticket: MandateWorkTicket; state: MandateWorkTicketState }>();
  function fail(): never { throw new RequestError('MANDATE_WORK_CONFLICT', 'This original request or another related mandate operation needs checking before continuing.'); }
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
    const ticket = Object.freeze({ id: ++next, request }); active.set(ticket.id, { ticket, state: 'unsent' }); return ticket;
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
  }
  function state(ticket: MandateWorkTicket): MandateWorkTicketState | null { const entry = active.get(ticket.id); return entry?.ticket === ticket ? entry.state : null; }
  function release(ticket: MandateWorkTicket) { if (active.get(ticket.id)?.ticket === ticket) active.delete(ticket.id); }
  // Revoking client ownership never deletes a durable locator or cancels server work.
  function clear() { ended = true; active.clear(); }
  return { acquire, assert, markDispatched, state, release, clear };
}
export type MandateWorkCoordinator = ReturnType<typeof createMandateWorkCoordinator>;
