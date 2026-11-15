'use client';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { RequestError } from '../lib/api';
import { immutableMandate } from '../lib/mandate-capsule';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import { qualifyAuthoringOperation, type MandateAuthoringCapsule } from '../lib/mandate-authoring';
import { assertAuthoringAttempt, listAuthoringManifests, locatorFromAuthoringCapsule, type AuthoringLocator } from '../lib/mandate-authoring-recovery';
import { authoringWork, createMandateWorkCoordinator, decisionWork } from '../lib/mandate-work-coordination';
import { mandateRecoveryScope, readMandateRecovery } from '../lib/mandate-recovery';
import type { AuthoringQualifiedReceipt } from '../lib/mandate-authoring-transport';
import type { MandateReadScope } from '../lib/mandates';
import { useMandateRecoveryMemory } from './mandate-recovery-memory';
type MemoryScope = Omit<MandateReadScope, 'responsibilityId'>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function useAuthoringStore(scope: MemoryScope) {
  const c1 = useMandateRecoveryMemory(), c1Ref = useRef(c1); c1Ref.current = c1;
  const alive = useRef(false), denied = useRef(false), capsules = useRef(new Map<string, MandateAuthoringCapsule>()), receipts = useRef(new Map<string, MandateOperationResult>()), qualifiedReceipts = useRef(new Map<string, AuthoringQualifiedReceipt>()), selection = useRef<MandateAuthoringCapsule | null>(null);
  const [ready, setReady] = useState(false), [hidden, setHidden] = useState(false), [, update] = useState(0);
  const [inventory, setInventory] = useState<ReturnType<typeof listAuthoringManifests>>({ blocked: true, manifests: [] });
  function assertAlive() { if (!alive.current || denied.current || c1Ref.current.hidden) throw new RequestError('MANDATE_SCOPE_CHANGED', 'This private authoring scope has ended.', 403); }
  function checkScope(value: MandateReadScope) { const { responsibilityId: _, ...owner } = value; if (!same(owner, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original private authoring scope changed.', 403); }
  const coordinator = useRef<ReturnType<typeof createMandateWorkCoordinator> | null>(null);
  function makeCoordinator() { return createMandateWorkCoordinator(() => {
    assertAlive(); const storage = browserRecoveryStorage(), list = listAuthoringManifests(storage, scope), old = readMandateRecovery(storage, scope);
    return { blocked: list.blocked || old.state === 'blocked', records: [...list.manifests.flatMap(item => item.pending ? [authoringWork(item.pending)] : []), ...(old.state === 'pending' ? [decisionWork(old.locator)] : [])] };
  }); }
  if (!coordinator.current) coordinator.current = makeCoordinator();
  function reload() { assertAlive(); setInventory(listAuthoringManifests(browserRecoveryStorage(), scope)); setReady(true); update(n => n + 1); }
  useLayoutEffect(() => {
    alive.current = true; denied.current = false; coordinator.current = makeCoordinator(); reload();
    return () => { alive.current = false; coordinator.current?.clear(); capsules.current.clear(); receipts.current.clear(); qualifiedReceipts.current.clear(); selection.current = null; };
  }, [scope]); // Scope identity is pinned by the keyed workspace provider.
  function deny() { denied.current = true; coordinator.current?.clear(); capsules.current.clear(); receipts.current.clear(); qualifiedReceipts.current.clear(); selection.current = null; setHidden(true); setInventory({ blocked: true, manifests: [] }); }
  useLayoutEffect(() => { if (c1.hidden) deny(); }, [c1.hidden]);
  function retain(input: MandateAuthoringCapsule) { assertAlive(); checkScope(input.scope); const value = immutableMandate(structuredClone(input)); capsules.current.set(canonicalJson(locatorFromAuthoringCapsule(value)), value); selection.current = value; update(n => n + 1); }
  function select(input: MandateAuthoringCapsule | null) { if (input) retain(input); else { assertAlive(); selection.current = null; update(n => n + 1); } }
  function original(locator: AuthoringLocator) { assertAlive(); return capsules.current.get(canonicalJson(locator)) ?? null; }
  function recorded(locator: AuthoringLocator) { assertAlive(); return receipts.current.get(canonicalJson(locator)) ?? null; }
  function onRecorded(locator: AuthoringLocator, input: MandateOperationResult) {
    assertAlive(); if (!same(locator.scope, mandateRecoveryScope(scope))) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The recorded result belongs to another scope.', 403);
    const result = qualifyAuthoringOperation(input, locator);
    if (!mandateOperationSucceeded(result)) throw new RequestError('AUTHORING_UNCONFIRMED', 'This original operation is not confirmed.');
    const key = canonicalJson(locator), prior = receipts.current.get(key);
    if (prior && !same(prior, result)) throw new RequestError('AUTHORING_UNCONFIRMED', 'The original recorded result changed.');
    receipts.current.set(key, immutableMandate(structuredClone(result))); reload();
  }
  function onPending(locator: AuthoringLocator) { assertAlive(); if (!same(locator.scope, mandateRecoveryScope(scope))) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original pending reference belongs to another scope.', 403); assertAuthoringAttempt(browserRecoveryStorage(), locator); reload(); }
  function onQualified(receipt: AuthoringQualifiedReceipt) { assertAlive(); if (!same(receipt.locator.scope, mandateRecoveryScope(scope))) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The qualified record belongs to another scope.', 403); qualifiedReceipts.current.set(canonicalJson(receipt.locator), immutableMandate(structuredClone(receipt))); update(n => n + 1); }
  function qualified(locator: AuthoringLocator) { assertAlive(); return qualifiedReceipts.current.get(canonicalJson(locator)) ?? null; }
  return { ready, hidden, inventory, reload, deny, retain, select, original, recorded, onRecorded, onPending, onQualified, qualified,
    selected: () => { assertAlive(); return selection.current ? { preparationId: selection.current.manifest.preparationId, integrityHash: selection.current.integrityHash } : null; },
    storage: () => { assertAlive(); return browserRecoveryStorage(); },
    work: { acquire: (input: Parameters<ReturnType<typeof createMandateWorkCoordinator>['acquire']>[0]) => { assertAlive(); return coordinator.current!.acquire(input); }, assert: (ticket: Parameters<ReturnType<typeof createMandateWorkCoordinator>['assert']>[0]) => { assertAlive(); coordinator.current!.assert(ticket); }, markDispatched: (ticket: Parameters<ReturnType<typeof createMandateWorkCoordinator>['markDispatched']>[0]) => { assertAlive(); coordinator.current!.markDispatched(ticket); }, state: (ticket: Parameters<ReturnType<typeof createMandateWorkCoordinator>['state']>[0]) => coordinator.current!.state(ticket), release: (ticket: Parameters<ReturnType<typeof createMandateWorkCoordinator>['release']>[0]) => coordinator.current!.release(ticket), clear: () => coordinator.current!.clear() },
  };
}
type Memory = ReturnType<typeof useAuthoringStore>;
const Context = createContext<Memory | null>(null);
export function MandateAuthoringMemoryProvider({ scope, children }: { scope: MemoryScope; children: ReactNode }) { const memory = useAuthoringStore(scope); return <Context value={memory}>{children}</Context>; }
export function useMandateAuthoringMemory() { const value = useContext(Context); if (!value) throw new Error('Authenticated mandate authoring memory is required'); return value; }
