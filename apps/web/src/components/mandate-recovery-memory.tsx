'use client';
import Link from 'next/link';
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { sameMandateValue, qualifyMandateOperation, mandateOperationSucceeded } from '../lib/mandate-actions';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { RequestError } from '../lib/api';
import { locatorFromCapsule, readMandateRecovery, removeMandateRecovery, storeMandateRecovery, type MandateRecovery, type MandateRecoverySlot } from '../lib/mandate-recovery';
import type { MandateCapsule } from '../lib/mandate-capsule';
import { mandateProposalHref, type MandateReadScope } from '../lib/mandates';
type MemoryScope = Omit<MandateReadScope, 'responsibilityId'>;
type Receipt = { locator: MandateRecovery; result: MandateOperationResult };
type Memory = { scope: MemoryScope; ready: boolean; hidden: boolean; inFlight: boolean; slot: MandateRecoverySlot; capsule: MandateCapsule | null; confirmed: Receipt | null; receipt: Receipt | null;
  begin: (capsule: MandateCapsule) => void; resume: (capsule: MandateCapsule) => void; confirm: (locator: MandateRecovery, result: MandateOperationResult) => void; resolve: (locator: MandateRecovery) => boolean; finish: () => void; deny: () => void; reload: () => void };
const Context = createContext<Memory | null>(null);
export function MandateRecoveryMemoryProvider({ scope, children }: { scope: MemoryScope; children: ReactNode }) {
  const [ready, setReady] = useState(false), [hidden, setHidden] = useState(false), [inFlight, setInFlight] = useState(false);
  const [slot, setSlot] = useState<MandateRecoverySlot>({ state: 'blocked' }), [capsule, setCapsule] = useState<MandateCapsule | null>(null), [confirmed, setConfirmed] = useState<Receipt | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const alive = useRef(false), denied = useRef(false), transmitting = useRef(false), pending = useRef<MandateRecoverySlot>({ state: 'blocked' }), confirmation = useRef<Receipt | null>(null);
  const reload = useCallback(() => { if (!alive.current) return; const value = readMandateRecovery(browserRecoveryStorage(), scope); pending.current = value; setSlot(value); setReady(true); }, [scope]);
  useLayoutEffect(() => { alive.current = true; reload(); return () => { alive.current = false; pending.current = { state: 'blocked' }; confirmation.current = null; }; }, [reload]);
  function assertAlive() { if (!alive.current || denied.current) throw new RequestError('MANDATE_SCOPE_CHANGED', 'This authenticated mandate recovery scope has ended.', 403); }
  function begin(value: MandateCapsule) {
    assertAlive(); const { responsibilityId: _, ...originalScope } = value.scope;
    if (!sameMandateValue(scope, originalScope) || pending.current.state !== 'empty' || transmitting.current) throw new RequestError('MANDATE_RECOVERY_OCCUPIED', 'Resolve the existing mandate reference before sending another decision.');
    const locator = locatorFromCapsule(value);
    try { storeMandateRecovery(browserRecoveryStorage(), locator); } catch (error) { reload(); throw error; }
    pending.current = { state: 'pending', locator }; transmitting.current = true; setSlot(pending.current); setCapsule(value); setInFlight(true); setReceipt(null); setConfirmed(null); confirmation.current = null;
  }
  function resume(value: MandateCapsule) {
    assertAlive(); const locator = locatorFromCapsule(value), stored = readMandateRecovery(browserRecoveryStorage(), scope), { responsibilityId: _, ...originalScope } = value.scope;
    if (transmitting.current || confirmation.current || !sameMandateValue(scope, originalScope) || stored.state !== 'pending' || !sameMandateValue(stored.locator, locator) || pending.current.state !== 'pending' || !sameMandateValue(pending.current.locator, locator)) throw new RequestError('MANDATE_RECOVERY_OCCUPIED', 'The original recovery reference changed or is already being checked. No retry was sent.');
    transmitting.current = true; setInFlight(true);
  }
  function confirm(locator: MandateRecovery, resultInput: MandateOperationResult) {
    assertAlive(); const result = qualifyMandateOperation(resultInput, locator);
    if (!mandateOperationSucceeded(result) || pending.current.state !== 'pending' || !sameMandateValue(pending.current.locator, locator)) throw new RequestError('MANDATE_DECISION_UNVERIFIED', 'The original decision reference changed.');
    confirmation.current = { locator, result }; setConfirmed(confirmation.current);
  }
  function resolve(locator: MandateRecovery) {
    assertAlive(); if (!confirmation.current || !sameMandateValue(confirmation.current.locator, locator)) return false;
    if (!removeMandateRecovery(browserRecoveryStorage(), locator)) return false;
    setReceipt(confirmation.current); confirmation.current = null; setConfirmed(null); setCapsule(null); pending.current = { state: 'empty' }; setSlot(pending.current); return true;
  }
  const finish = () => { transmitting.current = false; if (alive.current) setInFlight(false); };
  const deny = () => { denied.current = true; setHidden(true); setCapsule(null); confirmation.current = null; setConfirmed(null); setReceipt(null); setInFlight(false); };
  return <Context value={{ scope, ready, hidden, inFlight, slot, capsule, confirmed, receipt, begin, resume, confirm, resolve, finish, deny, reload }}>{children}</Context>;
}
export function useMandateRecoveryMemory() { const value = useContext(Context); if (!value) throw new Error('Authenticated mandate recovery is required'); return value; }
export function MandateRecoveryNotice({ workspace = false }: { workspace?: boolean }) {
  const memory = useMandateRecoveryMemory();
  if (!memory.ready || memory.hidden || memory.slot.state !== 'pending') return null;
  const locator = memory.slot.locator;
  return <div className={workspace ? 'mandate-workspace-notice' : 'mandate-recovery-notice'} role="status"><span>{memory.confirmed ? 'A mandate decision was recorded. Its exact record still needs checking.' : 'A mandate decision needs its original result checked.'}</span><Link className="text-action" href={`${mandateProposalHref(locator.responsibilityId, locator.proposal.id, locator.proposal.version)}#mandate-recovery`}>Open original decision</Link></div>;
}
