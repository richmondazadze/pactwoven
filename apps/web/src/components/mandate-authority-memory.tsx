'use client';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { RequestError } from '../lib/api';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { immutableMandate } from '../lib/mandate-capsule';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import { qualifyAuthorityOperation, qualifyAuthorityReceipt, type MandateAuthorityCapsule, type MandateAuthorityReceipt } from '../lib/mandate-authority';
import { assertAuthorityRecovery, listAuthorityRecovery, locatorFromAuthorityCapsule, type MandateAuthorityLocator } from '../lib/mandate-authority-recovery';
import { mandateRecoveryScope } from '../lib/mandate-recovery';
import type { MandateReadScope } from '../lib/mandates';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateRecoveryMemory } from './mandate-recovery-memory';

type MemoryScope = Omit<MandateReadScope, 'responsibilityId'>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function useAuthorityStore(scope: MemoryScope) {
  const authoring = useMandateAuthoringMemory(), c1 = useMandateRecoveryMemory(), parents = useRef({ authoring, c1 }); parents.current = { authoring, c1 };
  const alive = useRef(false), denied = useRef(false), selection = useRef<MandateAuthorityCapsule | null>(null);
  const capsules = useRef(new Map<string, MandateAuthorityCapsule>()), recordedResults = useRef(new Map<string, MandateOperationResult>()), qualifiedResults = useRef(new Map<string, MandateAuthorityReceipt>()), inFlight = useRef(new Map<string, object>());
  const [ready, setReady] = useState(false), [hidden, setHidden] = useState(false), [inventory, setInventory] = useState<ReturnType<typeof listAuthorityRecovery>>({ blocked: true, locators: [] }), [, update] = useState(0);
  function assertAlive() { if (!alive.current || denied.current || parents.current.authoring.hidden || parents.current.c1.hidden) throw new RequestError('MANDATE_SCOPE_CHANGED', 'This private authority-control scope has ended.', 403); }
  function checkLocator(locator: MandateAuthorityLocator) { assertAlive(); if (!same(locator.scope, mandateRecoveryScope(scope))) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original authority reference belongs to another scope.', 403); }
  function purge() { selection.current = null; capsules.current.clear(); recordedResults.current.clear(); qualifiedResults.current.clear(); inFlight.current.clear(); }
  function reload() { assertAlive(); const value = listAuthorityRecovery(browserRecoveryStorage(), scope); setInventory(value); setReady(true); update(n => n + 1); return value; }
  useLayoutEffect(() => { alive.current = true; denied.current = false; reload(); return () => { alive.current = false; purge(); }; }, [scope]);
  function deny() { if (denied.current) return; denied.current = true; purge(); setHidden(true); setInventory({ blocked: true, locators: [] }); parents.current.c1.deny(); parents.current.authoring.deny(); }
  useLayoutEffect(() => { if (authoring.hidden || c1.hidden) deny(); }, [authoring.hidden, c1.hidden]);
  function retain(input: MandateAuthorityCapsule) {
    assertAlive(); const { responsibilityId: _, ...owner } = input.scope;
    if (!same(owner, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The private authority review belongs to a different session or access scope.', 403);
    const value = immutableMandate(structuredClone(input)); capsules.current.set(canonicalJson(locatorFromAuthorityCapsule(value)), value); selection.current = value; update(n => n + 1);
  }
  function select(value: MandateAuthorityCapsule | null) { if (value) retain(value); else { assertAlive(); selection.current = null; update(n => n + 1); } }
  function releaseSelection(value: MandateAuthorityCapsule) { if (selection.current?.integrityHash === value.integrityHash) { selection.current = null; if (alive.current && !denied.current) update(n => n + 1); } }
  function original(locator: MandateAuthorityLocator) { checkLocator(locator); return capsules.current.get(canonicalJson(locator)) ?? null; }
  function recorded(locator: MandateAuthorityLocator) { checkLocator(locator); return recordedResults.current.get(canonicalJson(locator)) ?? null; }
  function onPending(locator: MandateAuthorityLocator) { checkLocator(locator); assertAuthorityRecovery(browserRecoveryStorage(), locator); reload(); }
  function onRecorded(locator: MandateAuthorityLocator, input: MandateOperationResult) {
    checkLocator(locator); const result = qualifyAuthorityOperation(input, locator), key = canonicalJson(locator), prior = recordedResults.current.get(key);
    if (!mandateOperationSucceeded(result) || (prior && !same(prior, result))) throw new RequestError('MANDATE_AUTHORITY_UNVERIFIED', 'The exact original authority receipt changed or is not confirmed.');
    recordedResults.current.set(key, result); reload();
  }
  function onQualified(input: MandateAuthorityReceipt) { checkLocator(input.locator); const receipt = qualifyAuthorityReceipt(input.result, input.locator); qualifiedResults.current.set(canonicalJson(receipt.locator), receipt); update(n => n + 1); }
  function start(locator: MandateAuthorityLocator) { checkLocator(locator); const key = canonicalJson(locator); if (inFlight.current.has(key)) throw new RequestError('MANDATE_WORK_CONFLICT', 'This original authority request is already being checked.'); const owner = {}; inFlight.current.set(key, owner); update(n => n + 1); return owner; }
  function finish(locator: MandateAuthorityLocator, owner: object) { const key = canonicalJson(locator); if (inFlight.current.get(key) === owner) { inFlight.current.delete(key); if (alive.current && !denied.current) update(n => n + 1); } }
  return { ready, hidden: hidden || authoring.hidden || c1.hidden, inventory, reload, deny, retain, select, releaseSelection, original, recorded, onPending, onRecorded, onQualified, start, finish,
    receipts: [...qualifiedResults.current.values()], busy: (locator: MandateAuthorityLocator) => inFlight.current.has(canonicalJson(locator)),
    selected: () => { assertAlive(); return selection.current ? { integrityHash: selection.current.integrityHash } : null; },
    storage: () => { assertAlive(); return browserRecoveryStorage(); }, work: authoring.work,
  };
}
export type MandateAuthorityMemory = ReturnType<typeof useAuthorityStore>;
const Context = createContext<MandateAuthorityMemory | null>(null);
export function MandateAuthorityMemoryProvider({ scope, children }: { scope: MemoryScope; children: ReactNode }) { const memory = useAuthorityStore(scope); return <Context value={memory}>{children}</Context>; }
export function useMandateAuthorityMemory() { const value = useContext(Context); if (!value) throw new Error('Authenticated authority-control memory is required'); return value; }
