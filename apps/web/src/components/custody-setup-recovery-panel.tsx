'use client';
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CustodyResult } from '@pactwoven/contracts';
import type { RecoveryStorage } from '../lib/bootstrap-recovery';
import { CustodyClientError, CustodyScopeSchema, custodyParse, custodySame, custodyScopeKey, custodyVisibleIdentity,
  freezeCustody, type CustodyLocator, type CustodyScope } from '../lib/custody-setup-contract';
import { custodyReferenceKey, listCustodyReferences, settleCustodyReference, type CustodyMemory } from '../lib/custody-setup-recovery';
import { createCustodyLifetime, createCustodyTransport } from '../lib/custody-setup-transport';
import { ActionLabel, Alert, Panel, StatusBadge } from './ui';
import { useArrival, useMotion } from './motion';

export type CustodyRecoveryPanelAdapters = {
  scope: CustodyScope;
  memory: CustodyMemory;
  currentScope: () => CustodyScope | null;
  storage: () => RecoveryStorage | null;
  getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};
type RecoveryRow = Readonly<{ locator: CustodyLocator; state: 'unchecked' | 'checking' | 'recorded' | 'not-recorded' | 'unconfirmed' | 'settling' | 'settled'; result: CustodyResult | null; message: string }>;
type RecoveryView = Readonly<{ visible: boolean; denied: boolean; blocked: boolean; busy: boolean; rows: readonly RecoveryRow[];
  feedback: string; revision: number; focus: Readonly<{ sequence: number; key: string }> | null }>;
const stopped = () => new CustodyClientError('scope', 'The custody recovery observation ended.');
const initialView = (): RecoveryView => ({ visible: false, denied: false, blocked: false, busy: false, rows: [], feedback: '', revision: 0, focus: null });
const unconfirmed = 'The original result is unconfirmed. Its saved reference remains available for another explicit check.';
const labels = { prepare: 'Draft preparation', challenge: 'Wallet challenge', confirmation: 'Confirmation challenge', confirm: 'Owner binding', cancel: 'Setup cancellation' } as const;
function safeMessage(error: unknown): string {
  if (!(error instanceof CustodyClientError)) return unconfirmed;
  if (error.code === 'storage') return 'Recovery storage needs attention. Preserve the original reference and check its local storage access.';
  if (error.code === 'unavailable') return 'Custody setup is unavailable. The original reference has been preserved.';
  if (error.code === 'not-found') return 'No original result was found at this check. The request may still finish; its reference has been preserved.';
  if (error.code === 'scope') return 'Current owner access is required. The original reference has been preserved.';
  if (error.code === 'expired' || error.code === 'verification') return 'Current verification is required to check this original. Its reference has been preserved.';
  return unconfirmed;
}

/** Local observation controller. It exposes neither mutation nor signing methods. */
export function createCustodyRecoveryPanelController(adapters: CustodyRecoveryPanelAdapters, isCurrent: () => boolean = () => true) {
  const scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(adapters.scope)));
  const memory = adapters.memory, storage = adapters.storage, currentScope = adapters.currentScope;
  const getToken = adapters.getToken, fetcher = adapters.fetch, lifetime = createCustodyLifetime(scope);
  const subscribers = new Set<() => void>();
  let view = initialView(), alive = true, visible = false, denied = false, generation = 0, active: object | null = null, focusSequence = 0;
  const serverView = initialView();
  function current() { try { return alive && visible && !denied && isCurrent() && custodySame(currentScope(), scope) && custodySame(memory.scope, scope); } catch { return false; } }
  const publish = (next: RecoveryView) => { view = freezeCustody(next); for (const subscriber of subscribers) subscriber(); };
  const updateRow = (key: string, changes: Partial<RecoveryRow>, feedback: string, focus = false) => publish({ ...view,
    rows: view.rows.map(row => custodyReferenceKey(row.locator) === key ? { ...row, ...changes } : row), feedback,
    revision: view.revision + 1, focus: focus ? { sequence: ++focusSequence, key } : view.focus });
  function inventory() {
    if (!current()) throw stopped();
    return listCustodyReferences(storage(), scope);
  }
  function refresh() {
    if (!current()) { hide(); return; }
    if (active) return;
    let listed: ReturnType<typeof inventory>;
    try { listed = inventory(); } catch { listed = { blocked: true, references: [] }; }
    if (!current()) return;
    const rows: RecoveryRow[] = listed.references.map(locator => view.rows.find(row => custodySame(row.locator, locator)) ?? {
      locator, state: 'unchecked', result: null, message: 'This saved original has not been checked in this view.' });
    // Keep a settled receipt in place for reading and focus during this view.
    for (const row of view.rows) if (row.state === 'settled' && !rows.some(value => custodySame(value.locator, row.locator))) rows.push(row);
    publish({ ...view, visible: true, rows, blocked: listed.blocked, feedback: 'Saved references refreshed. No request was sent.', revision: view.revision + 1 });
  }
  function invalidate() { generation++; active = null; lifetime.hide(); }
  function hide() { visible = false; invalidate(); publish({ ...initialView(), denied }); }
  function activate() {
    if (!alive) return;
    invalidate(); visible = true;
    if (!current()) { hide(); return; }
    lifetime.activate(scope); publish({ ...initialView(), visible: true }); refresh();
  }
  function action(key: string) {
    if (!current()) { hide(); return null; }
    if (active) return null;
    const row = view.rows.find(value => custodyReferenceKey(value.locator) === key);
    if (!row || row.state === 'settled') return null;
    let store: RecoveryStorage | null;
    try { store = storage(); } catch { store = null; }
    const ticket = {}, epoch = generation;
    if (!store) { updateRow(key, { message: safeMessage(new CustodyClientError('storage', '')) }, 'Recovery storage needs attention.', true); return null; }
    active = ticket;
    const guard = () => {
      if (generation !== epoch || active !== ticket) throw stopped();
      let sameStorage = false;
      try { sameStorage = storage() === store; } catch { /* Loss of storage ends this observation. */ }
      if (!current() || !sameStorage) { hide(); throw stopped(); }
    };
    const getItem = store.getItem.bind(store), removeItem = store.removeItem.bind(store), storageKey = store.key.bind(store);
    // The settlement helper awaits digest verification. Recheck the live scope
    // at each storage access, including immediately before exact local removal.
    const guardedStorage: RecoveryStorage = {
      get length() { guard(); return store.length; }, key(index) { guard(); return storageKey(index); },
      getItem(name) { guard(); return getItem(name); },
      setItem() { throw stopped(); },
      removeItem(name) { guard(); if (name !== key) throw stopped(); removeItem(name); },
    };
    const finish = () => { if (active === ticket) { active = null; if (current()) publish({ ...view, busy: false }); } };
    publish({ ...view, busy: true });
    return { row, guard, guardedStorage, finish };
  }
  async function check(key: string) {
    let work: ReturnType<typeof action>;
    try { work = action(key); } catch { return; }
    if (!work) return;
    const { row, guard, guardedStorage, finish } = work;
    updateRow(key, { state: 'checking', message: 'Checking the exact original request…' }, 'Checking original result…');
    try {
      guard();
      const transport = createCustodyTransport({ lifetime, memory, storage: () => guardedStorage,
        currentScope: () => { try { guard(); return currentScope(); } catch { return null; } }, getToken, fetch: fetcher });
      const permission = lifetime.authorize('lookup', custodyVisibleIdentity(scope, row.locator));
      const result = await transport.lookup(row.locator, scope, permission); guard();
      // An earlier qualified receipt cannot be replaced by a later missing read.
      if (!result.operation && row.result) throw new CustodyClientError('unconfirmed', '');
      updateRow(key, { state: result.operation ? 'recorded' : 'not-recorded', result: result.operation,
        message: result.operation ? 'The exact original operation is recorded. Review this historical receipt before clearing its local reminder.'
          : 'No original result was found at this check. The request may still finish; its reference has been preserved.' },
      result.operation ? 'Original receipt ready for review.' : 'Original check finished without a recorded result.', true);
    } catch (error) {
      try {
        guard();
        if (error instanceof CustodyClientError && error.code === 'scope') { denied = true; hide(); }
        else updateRow(key, { state: row.result ? 'recorded' : 'unconfirmed', result: row.result, message: safeMessage(error) }, 'Original check needs attention.', true);
      } catch { /* A departed observation cannot update this view. */ }
    } finally { finish(); }
  }
  async function settle(key: string) {
    const existing = view.rows.find(row => custodyReferenceKey(row.locator) === key);
    if (existing?.state !== 'recorded' || !existing.result) return;
    let work: ReturnType<typeof action>;
    try { work = action(key); } catch { return; }
    if (!work) return;
    const { row, guard, guardedStorage, finish } = work;
    updateRow(key, { state: 'settling', message: 'Checking the reviewed receipt and its local reminder…' }, 'Clearing the reviewed local reminder…');
    try {
      guard();
      const result = await settleCustodyReference(guardedStorage, row.locator, row.result!, memory.original(row.locator) ?? undefined); guard();
      updateRow(key, { state: 'settled', result, message: 'The local reminder is cleared. This historical receipt remains visible for this view; the server record is unchanged.' }, 'Reviewed local reminder cleared.', true);
    } catch (error) {
      try { guard(); updateRow(key, { state: 'recorded', message: safeMessage(error) }, 'The recorded receipt is preserved; local cleanup needs attention.', true); } catch { /* Do not remove or reveal a departed scope. */ }
    } finally { finish(); }
  }
  return { scope, getSnapshot: () => view, getServerSnapshot: () => serverView,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    current, activate, hide, refresh, check, settle,
    close() { hide(); alive = false; lifetime.close(); subscribers.clear(); },
  };
}

export function CustodySetupRecoveryPanel(props: CustodyRecoveryPanelAdapters) {
  const latest = useRef(props); latest.current = props;
  const scopeKey = custodyScopeKey(props.scope);
  const previousScope = useRef(scopeKey), deniedScope = useRef<string | null>(null);
  if (previousScope.current !== scopeKey) { previousScope.current = scopeKey; deniedScope.current = null; }
  const controller = useMemo(() => {
    const { memory, currentScope, storage, getToken, fetch: fetcher } = props;
    return createCustodyRecoveryPanelController(props, () => {
      const next = latest.current;
      return deniedScope.current !== scopeKey && !document.hidden && custodyScopeKey(next.scope) === scopeKey && next.memory === memory && next.currentScope === currentScope
        && next.storage === storage && next.getToken === getToken && next.fetch === fetcher;
    });
  }, [scopeKey, props.memory, props.currentScope, props.storage, props.getToken, props.fetch]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  if (view.denied) deniedScope.current = scopeKey;
  const targets = useRef(new Map<string, HTMLDivElement>()), focus = useRef<{ controller: typeof controller; sequence: number } | null>(null);
  const motion = useMotion(), arrival = useArrival(view.revision, 120);
  useLayoutEffect(() => {
    const visibility = () => document.hidden ? controller.hide() : controller.activate();
    visibility(); document.addEventListener('visibilitychange', visibility);
    // Suspend on cleanup so React's development effect replay can activate the
    // same observation again. Hidden/old controllers cannot complete work.
    return () => { document.removeEventListener('visibilitychange', visibility); controller.hide(); };
  }, [controller]);
  useLayoutEffect(() => {
    const requested = view.focus;
    if (!view.visible || !requested || !controller.current() || (focus.current?.controller === controller && focus.current.sequence === requested.sequence)) return;
    focus.current = { controller, sequence: requested.sequence };
    const target = targets.current.get(requested.key); if (!target) return;
    target.focus({ preventScroll: true });
    const instant = motion.mode !== 'normal' || motion.keyboard.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'nearest', behavior: instant ? 'instant' : 'smooth' });
  }, [controller, view.focus, view.visible]);
  if (deniedScope.current === scopeKey && !document.hidden) return <Alert title="Current owner access is required"><p>Refresh your authenticated workspace before checking saved setup requests. Original references remain stored; no request was sent again.</p></Alert>;
  if (!view.visible || !controller.current()) return null;
  return <section className="mandate-authoring mandate-authority-recovery" aria-label="Custody setup recovery">
    <Panel title="Custody setup recovery" action={<button className="button secondary" type="button" disabled={view.busy} onClick={controller.refresh}><ActionLabel label="Refresh saved references" reserve={['Refresh saved references']}/></button>}>
      <p>Check a saved development setup request without sending it again. A recovered receipt records an earlier action; it does not authorize signing or spending.</p>
      <div ref={arrival}><p className="review-note" role="status" aria-live="polite">{view.feedback}</p></div>
      {view.blocked && <Alert title="Recovery storage needs attention"><p>Some references could not be read. Readable originals remain below. Keep the stored references while resolving storage access.</p></Alert>}
      {!view.rows.length && <p className="review-note">No readable custody setup references are saved for this owner and responsibility in this browser.</p>}
    </Panel>
    {view.rows.map(row => { const key = custodyReferenceKey(row.locator), receipt = row.result, recorded = Boolean(receipt);
      return <section className="panel" key={key} aria-label={`${labels[row.locator.kind]} original ${row.locator.key}`}>
        <div className="panel-heading"><h3>{labels[row.locator.kind]}</h3><StatusBadge tone={recorded ? 'blue' : 'amber'}>{recorded ? 'Historical receipt' : 'Unconfirmed original'}</StatusBadge></div>
        <div className="panel-body">
          <div ref={node => { if (node) targets.current.set(key, node); else targets.current.delete(key); }} tabIndex={-1} className="access-heading-focus">
            <h4>{row.state === 'settled' ? 'Local reminder cleared' : recorded ? `${labels[row.locator.kind]} recorded` : 'Check the original result'}</h4><p>{row.message}</p>
          </div>
          <dl className="mandate-authoring-facts">
            <div><dt>Original action</dt><dd>{labels[row.locator.kind]} · <code>{row.locator.kind}</code></dd></div>
            <div><dt>Original request key</dt><dd><code>{row.locator.key}</code></dd></div>
            <div><dt>Setup</dt><dd><code>{receipt?.setupId ?? row.locator.setupId ?? 'Not returned yet'}</code></dd></div>
            <div><dt>Organization / responsibility</dt><dd>{controller.scope.organizationId}<br/>{controller.scope.responsibilityId}</dd></div>
            <div><dt>Reviewed specification</dt><dd>{row.locator.pins.specification.id} · version {row.locator.pins.specification.version}<br/><code>{row.locator.pins.specification.recordHash}</code></dd></div>
            {receipt && <><div><dt>Recorded operation</dt><dd><code>{receipt.id}</code></dd></div><div><dt>Recorded result</dt><dd>{receipt.body.kind} · version {receipt.target.version}<br/><code>{receipt.target.recordHash}</code></dd></div></>}
          </dl>
          {receipt?.kind === 'cancel' && <p className="review-note">This cancellation stopped new setup effects. Any earlier owner binding remains recorded. It does not withdraw a signed or unknown transaction.</p>}
          {receipt?.kind === 'confirm' && <p className="review-note">An owner binding is recorded. This receipt does not establish deployed custody, a balance, or permission to spend.</p>}
          {row.state !== 'settled' && <div className="actions">
            <button className="button secondary" type="button" disabled={view.busy} onClick={() => { void controller.check(key); }}><ActionLabel label={row.state === 'checking' ? 'Checking original result…' : 'Check original result'} reserve={['Checking original result…', 'Check original result']}/></button>
            {receipt && <button className="button secondary" type="button" disabled={view.busy || row.state !== 'recorded'} onClick={() => { void controller.settle(key); }}><ActionLabel label={row.state === 'settling' ? 'Clearing local reminder…' : 'Reviewed — clear local reminder'} reserve={['Reviewed — clear local reminder', 'Clearing local reminder…']}/></button>}
          </div>}
          {receipt && row.state !== 'settled' && <p className="review-note">Clearing removes only this browser’s saved reminder after receipt verification. It does not change the server operation.</p>}
        </div>
      </section>;
    })}
  </section>;
}
