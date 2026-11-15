'use client';
import { useAuth } from '@clerk/nextjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { IdSchema } from '@pactwoven/contracts';
import type { RecoveryStorage } from '../lib/bootstrap-recovery';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { apiRequest } from '../lib/api';
import { getApiBase } from '../lib/config';
import { scopedResponsibilitySchema } from '../lib/responsibilities';
import { CustodyClientError, custodySame, type CustodyScope } from '../lib/custody-setup-contract';
import { createCustodyMemory, type CustodyMemory } from '../lib/custody-setup-recovery';
import { canOpenCustodyRecovery, createCustodyRecoveryBootstrap, createCustodyRecoveryClock, custodyRecoveryBootstrapKey,
  readCustodyRecoveryContext, type CustodyRecoveryBootstrap, type CustodyRecoveryContextAdapters } from '../lib/custody-setup-context';
import { CustodySetupRecoveryPanel, type CustodyRecoveryPanelAdapters } from './custody-setup-recovery-panel';
import { useWorkspace } from './workspace-provider';
import { useArrival, useMotion } from './motion';
import { ActionLabel, Alert, ButtonLink, LoadingState, PageHeading, Panel } from './ui';

export type CustodyRecoveryWorkspaceAdapters = CustodyRecoveryContextAdapters & {
  bootstrap: CustodyRecoveryBootstrap; storage: () => RecoveryStorage | null; onDenied?: () => void;
};
type View = Readonly<{ visible: boolean; phase: 'idle' | 'checking' | 'ready' | 'expired' | 'unavailable' | 'denied';
  message: string; panel: CustodyRecoveryPanelAdapters | null; revision: number; focusSequence: number }>;
const initial = (): View => ({ visible: false, phase: 'idle', message: 'Check current owner access to open saved setup requests.', panel: null, revision: 0, focusSequence: 0 });
const deniedMessage = 'Current owner access could not be verified. Return to the workspace to check your organization access. Saved references remain stored.';
const expiredMessage = 'This recovery access observation ended. Check owner access again before opening saved requests.';

/** Route-local observation only. No setup send, wallet or signing method exists. */
export function createCustodyRecoveryWorkspaceController(adapters: CustodyRecoveryWorkspaceAdapters, isCurrent: () => boolean = () => true) {
  const bootstrap = structuredClone(adapters.bootstrap), currentBootstrap = adapters.currentBootstrap;
  const getToken = adapters.getToken, fetcher = adapters.fetch, storage = adapters.storage, onDenied = adapters.onDenied;
  const wallTime = adapters.wallTime ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const subscribers = new Set<() => void>(), serverView = initial();
  let view = initial(), visible = false, closed = false, denied = false, generation = 0, focusSequence = 0;
  let active: AbortController | null = null, expiryTimer: ReturnType<typeof setTimeout> | null = null, memory: CustodyMemory | null = null;
  let observedScope: CustodyScope | null = null, currentTime: (() => number) | null = null, expiresAt = 0;
  const publish = (next: View) => { view = Object.freeze(next); for (const listener of subscribers) listener(); };
  const current = () => { try { return !closed && visible && !denied && isCurrent() && getApiBase() === bootstrap.apiBase && custodySame(currentBootstrap(), bootstrap); } catch { return false; } };
  function invalidate() {
    generation++; active?.abort(); active = null;
    if (expiryTimer !== null) clearTimeout(expiryTimer); expiryTimer = null;
    memory?.close(); memory = null; observedScope = null; currentTime = null; expiresAt = 0;
  }
  function suspend() { visible = false; invalidate(); publish({ ...initial(), phase: denied ? 'denied' : 'idle' }); }
  function activate() { if (closed) return; invalidate(); visible = true;
    if (!current() && !denied) { suspend(); return; }
    publish({ ...initial(), visible: true, phase: denied ? 'denied' : 'idle', message: denied ? deniedMessage : initial().message });
  }
  const currentScope = () => {
    try { return current() && observedScope && currentTime && currentTime() < expiresAt ? observedScope : null; } catch { return null; }
  };
  function expire() { if (!current()) { suspend(); return; } invalidate();
    publish({ ...view, phase: 'expired', panel: null, message: expiredMessage, revision: view.revision + 1 });
  }
  async function refresh() {
    if (!current()) { if (!denied) suspend(); return; }
    if (active) return;
    invalidate(); const ticket = new AbortController(), epoch = generation; active = ticket;
    const guard = () => { if (active !== ticket || generation !== epoch || !current()) throw new CustodyClientError('scope', 'The recovery workspace changed.'); };
    publish({ ...view, phase: 'checking', panel: null, message: 'Checking current owner access…', revision: view.revision + 1 });
    try {
      const observation = await readCustodyRecoveryContext(bootstrap, { currentBootstrap: () => { try { guard(); return currentBootstrap(); } catch { return null; } },
        getToken, fetch: fetcher, wallTime, monotonic }, ticket.signal); guard();
      currentTime = createCustodyRecoveryClock(observation, wallTime, monotonic); expiresAt = Date.parse(observation.context.expiresAt);
      const remaining = expiresAt - currentTime(); if (remaining <= 0) throw new CustodyClientError('expired', expiredMessage);
      observedScope = observation.scope; memory = createCustodyMemory(observation.scope);
      const panel: CustodyRecoveryPanelAdapters = Object.freeze({ scope: observation.scope, memory, currentScope, storage, getToken, fetch: fetcher });
      expiryTimer = setTimeout(expire, remaining);
      publish({ visible: true, phase: 'ready', panel, message: 'Owner access checked. Choose a saved original to check its result.', revision: view.revision + 1, focusSequence: ++focusSequence });
    } catch (error) {
      if (generation !== epoch || active !== ticket) return;
      if (!current()) { suspend(); return; }
      invalidate();
      denied = error instanceof CustodyClientError && error.code === 'scope';
      const expired = error instanceof CustodyClientError && error.code === 'expired';
      const message = denied ? deniedMessage : expired ? expiredMessage
        : error instanceof CustodyClientError && error.code === 'unavailable' ? error.message
          : 'The current access check is unconfirmed. Saved references remain stored; check again when you are ready.';
      if (denied) { try { onDenied?.(); } catch { /* A failed workspace refresh cannot reopen this observation. */ } }
      publish({ visible: true, phase: denied ? 'denied' : expired ? 'expired' : 'unavailable', panel: null, message,
        revision: view.revision + 1, focusSequence: ++focusSequence });
    } finally { if (active === ticket) active = null; }
  }
  return { getSnapshot: () => view, getServerSnapshot: () => serverView,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    current, currentScope, activate, suspend, refresh, close() { suspend(); closed = true; subscribers.clear(); } };
}

export function CustodyRecoveryWorkspaceView(props: CustodyRecoveryWorkspaceAdapters) {
  const latest = useRef(props); latest.current = props;
  const key = custodyRecoveryBootstrapKey(props.bootstrap), denial = useRef<string | null>(null), priorKey = useRef(key);
  if (priorKey.current !== key) { priorKey.current = key; denial.current = null; }
  const controller = useMemo(() => createCustodyRecoveryWorkspaceController({ ...props, onDenied: () => {
    // Persist the denial before external authorization refresh or subscribers
    // can replace this controller without rendering its denied snapshot.
    denial.current = key; props.onDenied?.();
  } }, () => {
    const value = latest.current;
    return denial.current !== key && !document.hidden && custodyRecoveryBootstrapKey(value.bootstrap) === key
      && value.currentBootstrap === props.currentBootstrap && value.storage === props.storage && value.getToken === props.getToken
      && value.fetch === props.fetch && value.wallTime === props.wallTime && value.monotonic === props.monotonic && value.onDenied === props.onDenied;
  }), [key, props.currentBootstrap, props.storage, props.getToken, props.fetch, props.wallTime, props.monotonic, props.onDenied]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const arrival = useArrival(view.revision, 120), feedback = useRef<HTMLDivElement>(null), motion = useMotion();
  const focused = useRef<{ controller: typeof controller; sequence: number } | null>(null);
  useLayoutEffect(() => {
    const visibility = () => document.hidden ? controller.suspend() : controller.activate();
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); controller.suspend(); };
  }, [controller]);
  useLayoutEffect(() => {
    if (!view.visible || !view.focusSequence || !feedback.current || (focused.current?.controller === controller && focused.current.sequence === view.focusSequence)) return;
    focused.current = { controller, sequence: view.focusSequence }; feedback.current.focus({ preventScroll: true });
    feedback.current.scrollIntoView({ block: 'nearest', behavior: motion.mode !== 'normal' || motion.keyboard.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [controller, view.visible, view.focusSequence]);
  const back = <ButtonLink href={`/app/responsibilities/${encodeURIComponent(props.bootstrap.responsibilityId)}`} secondary>Back to responsibility</ButtonLink>;
  const accessDenied = denial.current === key || view.phase === 'denied';
  if (typeof document !== 'undefined' && document.hidden) return null;
  if (!view.visible && !accessDenied) return <LoadingState label="Opening saved setup requests"/>;
  const panel = view.phase === 'ready' && controller.currentScope() ? view.panel : null;
  return <><PageHeading title="Saved setup requests" description="Review original development setup results without sending the requests again." action={back}/>
    <Panel title="Current owner access" action={!accessDenied && <button className="button secondary" type="button" disabled={view.phase === 'checking'} onClick={() => { void controller.refresh(); }}>
      <ActionLabel label={view.phase === 'checking' ? 'Checking owner access…' : 'Check owner access'} reserve={['Checking owner access…', 'Check owner access']}/></button>}>
      <div ref={feedback} tabIndex={-1} className="access-heading-focus"><p role="status" aria-live="polite">{accessDenied ? deniedMessage : view.phase === 'ready' && !panel ? expiredMessage : view.message}</p></div>
      <div ref={arrival}><p className="review-note">This check opens saved request references only. It does not establish custody, wallet ownership, funds or permission to spend.</p></div>
    </Panel>
    {panel && <CustodySetupRecoveryPanel {...panel}/>}</>;
}

export function CustodySetupRecoveryWorkspace({ id }: { id: string }) {
  const { session, getToken: workspaceToken } = useWorkspace(), auth = useAuth(), client = useQueryClient();
  const routeId = IdSchema.safeParse(id), allowed = routeId.success && canOpenCustodyRecovery(session);
  const query = useQuery({ queryKey: ['responsibility', id], enabled: allowed,
    queryFn: ({ signal }) => apiRequest(`/v1/responsibilities/${encodeURIComponent(id)}`, scopedResponsibilitySchema(session)
      .refine(record => record.id === id, 'The responsibility must match this route.'), workspaceToken, { signal }), retry: false, refetchOnWindowFocus: false });
  const latest = useRef({ session, auth, record: query.data, unavailable: query.isError }); latest.current = { session, auth, record: query.data, unavailable: query.isError };
  const currentBootstrap = useCallback(() => { const value = latest.current; try { return value.record && !value.unavailable
    ? createCustodyRecoveryBootstrap(value.session, value.auth, getApiBase(), value.record, id) : null; } catch { return null; } }, [id]);
  const getToken = useCallback((options: { organizationId: string; skipCache: true }) => latest.current.auth.getToken(options), []);
  const storage = useCallback(() => browserRecoveryStorage(), []);
  const fetcher = useCallback((url: string, init: RequestInit) => fetch(url, init), []);
  const onDenied = useCallback(() => { void client.invalidateQueries({ queryKey: ['session'], exact: true }).catch(() => {}); }, [client]);
  if (!allowed) return <><PageHeading title="Saved setup requests"/><Alert title="Development owner access is required"><p>Saved custody setup requests are available to a current development organization owner.</p><ButtonLink href="/app/responsibilities" secondary>Back to responsibilities</ButtonLink></Alert></>;
  if (query.isPending) return <LoadingState label="Loading responsibility for recovery"/>;
  const bootstrap = currentBootstrap();
  if (!bootstrap) return <><PageHeading title="Saved setup requests"/><Alert title="Current responsibility access is unavailable"><p>Return to this responsibility to verify its current owner and site access. Saved setup references remain stored.</p><ButtonLink href={`/app/responsibilities/${encodeURIComponent(id)}`} secondary>Back to responsibility</ButtonLink></Alert></>;
  return <CustodyRecoveryWorkspaceView bootstrap={bootstrap} currentBootstrap={currentBootstrap} getToken={getToken} storage={storage} fetch={fetcher} onDenied={onDenied}/>;
}
