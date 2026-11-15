'use client';
import { useAuth } from '@clerk/nextjs';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IdSchema, FinancialPolicyVersionSchema, type FinancialPolicyHttpContext,
  type FinancialPolicyHttpRecordResponse, type FinancialPolicyHttpDraftIndexResponse, type FinancialPolicyHttpGovernanceIndexResponse } from '@pactwoven/contracts';
import { apiRequest } from '../lib/api';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { getApiBase } from '../lib/config';
import { scopedResponsibilitySchema } from '../lib/responsibilities';
import { FinancialPolicyClientError, financialSame, freezeFinancial, type FinancialPolicyReadTarget, type FinancialPolicyReference } from '../lib/financial-policy-contract';
import { createFinancialPolicyBootstrap, createFinancialPolicyClock, createFinancialPolicyLifetime, financialPolicyBootstrapKey,
  financialPolicyLocalScope, type FinancialPolicyBootstrap } from '../lib/financial-policy-context';
import { clearFinancialPolicyReminder, createFinancialPolicyMemory, listFinancialPolicyReferences, financialPolicyReferenceKey, type FinancialPolicyStorage } from '../lib/financial-policy-recovery';
import { createFinancialPolicyTransport, type FinancialPolicyTransportAdapters } from '../lib/financial-policy-transport';
import { FinancialPolicyRecoveryPanel, type FinancialPolicyRecoveryRow } from './financial-policy-recovery-panel';
import { FinancialPolicyReview, FinancialPolicyDocumentText, financialPolicyCollectionPath, financialPolicyVersionPath, financialPolicyLabel } from './financial-policy-review';
import { ActionLabel, Alert, ButtonLink, LoadingState, PageHeading, Panel, StatusBadge } from './ui';
import { useMotion } from './motion';
import { useWorkspace } from './workspace-provider';
import { BrandLoader } from './brand-loader';

export type FinancialPolicyWorkspaceAdapters = Omit<FinancialPolicyTransportAdapters, 'lifetime' | 'memory'> & { bootstrap: FinancialPolicyBootstrap };
type Index = FinancialPolicyHttpDraftIndexResponse | FinancialPolicyHttpGovernanceIndexResponse;
type View = Readonly<{ visible: boolean; phase: 'idle' | 'checking' | 'ready' | 'expired' | 'denied' | 'unavailable'; busy: boolean;
  context: FinancialPolicyHttpContext | null; index: Index | null; record: FinancialPolicyHttpRecordResponse | null;
  rows: readonly FinancialPolicyRecoveryRow[]; storageBlocked: boolean; message: string; focus: number }>;
const initial = (): View => ({ visible: false, phase: 'idle', busy: false, context: null, index: null, record: null, rows: [],
  storageBlocked: false, message: 'Check current access to open financial-policy records and saved references.', focus: 0 });
const deniedMessage = 'Current financial-policy access could not be verified. Private records have been cleared. Saved original references remain in this tab.';
const expiredMessage = 'This observation has expired. Refresh current context explicitly before another read.';
/** One owner per route, separate from replaceable transport/token adapters. No mount I/O. */
export function createFinancialPolicyWorkspaceController(first: FinancialPolicyWorkspaceAdapters, isCurrent: () => boolean = () => true) {
  let adapters = first, bootstrap = freezeFinancial(structuredClone(first.bootstrap));
  const lifetime = createFinancialPolicyLifetime(bootstrap, { wall: () => (adapters.wall ?? Date.now)(), monotonic: () => (adapters.monotonic ?? (() => performance.now()))() });
  let memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap));
  let transport = createFinancialPolicyTransport({ ...adapters, lifetime, memory });
  let view = initial(), visible = false, closed = false, denied = false, active: object | null = null, sequence = 0;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let displayDeadline = 0, displayNow: (() => number) | null = null;
  const serverView = initial(), subscribers = new Set<() => void>();
  function publish(next: View) { view = freezeFinancial(next); for (const subscriber of subscribers) subscriber(); }
  function clearTimer() { if (expiry !== null) clearTimeout(expiry); expiry = null; }
  function clearPrivate() { clearTimer(); displayDeadline = 0; displayNow = null; publish({ ...initial(), visible, phase: denied ? 'denied' : active ? 'checking' : 'idle', busy: active !== null,
    message: denied ? deniedMessage : initial().message, focus: view.focus }); }
  lifetime.onInvalidate(clearPrivate);
  function matches(next: FinancialPolicyWorkspaceAdapters) {
    try { return financialPolicyBootstrapKey(next.bootstrap) === financialPolicyBootstrapKey(bootstrap) &&
      next.currentBootstrap === adapters.currentBootstrap && next.getToken === adapters.getToken && next.fetch === adapters.fetch &&
      next.storage === adapters.storage && next.wall === adapters.wall && next.monotonic === adapters.monotonic; } catch { return false; }
  }
  function current() {
    try { return !closed && visible && isCurrent() && getApiBase() === bootstrap.apiBase && financialSame(adapters.currentBootstrap(), bootstrap); } catch { return false; }
  }
  function ready() {
    if (!current() || denied) throw new FinancialPolicyClientError('scope');
    if (displayNow && displayNow() >= displayDeadline) throw new FinancialPolicyClientError('expired');
    return lifetime.observation();
  }
  function expireDisplay() { active = null; lifetime.invalidate(); if (current()) publish({ ...view, phase: 'expired', message: expiredMessage, busy: false }); }
  function fresh() { try { return !view.context || Boolean(displayNow && displayNow() < displayDeadline); } catch { return false; } }
  function arm(responseExpiry?: string) {
    clearTimer(); const observation = ready();
    displayNow ??= createFinancialPolicyClock(observation.receivedAt, observation.receivedMonotonic, adapters.wall, adapters.monotonic);
    displayDeadline = Math.min(displayDeadline || observation.expiresAt, observation.expiresAt, responseExpiry ? Date.parse(responseExpiry) : Infinity);
    const remaining = displayDeadline - displayNow();
    if (remaining <= 0) throw new FinancialPolicyClientError('expired');
    expiry = setTimeout(expireDisplay, remaining);
  }
  function rows() {
    ready(); const inventory = listFinancialPolicyReferences(adapters.storage(), financialPolicyLocalScope(bootstrap));
    const next: FinancialPolicyRecoveryRow[] = inventory.references.map(reference => view.rows.find(row => financialSame(row.reference, reference)) ??
      { reference, state: 'unchecked', receipt: null, message: 'This original has not been checked in this view.' });
    for (const row of view.rows) if (row.state === 'cleared' && !next.some(other => financialSame(other.reference, row.reference))) next.push(row);
    publish({ ...view, rows: next, storageBlocked: inventory.blocked });
  }
  function row(reference: FinancialPolicyReference, update: Partial<FinancialPolicyRecoveryRow>) {
    const key = financialPolicyReferenceKey(reference);
    publish({ ...view, rows: view.rows.map(value => financialPolicyReferenceKey(value.reference) === key ? { ...value, ...update } : value) });
  }
  async function run(message: string, work: (check: () => void) => Promise<void>) {
    if (active || !current() || denied) return;
    const operation = {}, owner = transport; active = operation;
    publish({ ...view, busy: true, message });
    const check = () => { if (active !== operation || owner !== transport || !current()) throw new FinancialPolicyClientError('scope'); };
    try { await work(check); if (active !== operation || owner !== transport || !current()) return;
      publish({ ...view, focus: ++sequence });
    } catch (error) {
      if (active !== operation || owner !== transport) return;
      if (!current()) { suspend(); return; }
      const code = error instanceof FinancialPolicyClientError ? error.code : 'unconfirmed';
      if (code === 'scope') { denied = true; lifetime.deny(); }
      if (code === 'expired') lifetime.invalidate();
      publish({ ...view, phase: code === 'scope' ? 'denied' : code === 'expired' ? 'expired' : view.context ? 'ready' : 'unavailable',
        message: code === 'scope' ? deniedMessage : code === 'expired' ? expiredMessage : error instanceof FinancialPolicyClientError ? error.message : 'This read could not be confirmed. Saved originals are preserved.', focus: ++sequence });
    } finally { if (active === operation) { active = null; publish({ ...view, busy: false }); } }
  }
  function suspend() { visible = false; active = null; lifetime.hide(); }
  return {
    getSnapshot: () => view, getServerSnapshot: () => serverView,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    matches, current, fresh, expireDisplay,
    configure(next: FinancialPolicyWorkspaceAdapters) {
      if (closed || matches(next)) return;
      active = null; lifetime.invalidate(); memory.close(); adapters = next; bootstrap = freezeFinancial(structuredClone(next.bootstrap));
      denied = false;
      try { lifetime.activate(bootstrap); } catch { denied = true; }
      memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap));
      transport = createFinancialPolicyTransport({ ...adapters, lifetime, memory }); clearPrivate();
    },
    activate() {
      if (closed) return; visible = true; active = null;
      try { lifetime.activate(bootstrap); } catch { denied = true; }
      if (!current()) { suspend(); return; }
      publish({ ...initial(), visible: true, phase: denied ? 'denied' : 'idle', message: denied ? deniedMessage : initial().message });
    },
    suspend,
    refresh() { return run('Checking current financial-policy access…', async check => {
      const query = { assetKey: null }, observation = await transport.context(query, lifetime.authorize('context', query));
      check(); ready(); publish({ ...view, phase: 'ready', context: observation.context, message: 'Current context checked. Choose a record page or check an individual saved original.' });
      rows(); arm();
    }); },
    index(afterId: string | null = null) { return run('Reading financial-policy records…', async check => {
      ready(); const query = { responsibilityId: bootstrap.responsibilityId, afterId, limit: 25 };
      publish({ ...view, index: null, record: null });
      const value = await transport.index(query, lifetime.authorize('index', query)); check(); ready(); arm(value.observation.expiresAt);
      publish({ ...view, index: value, message: value.items.length ? 'Financial-policy record page checked.' : 'No financial-policy records were returned for this page.' });
    }); },
    read(target: FinancialPolicyReadTarget) { return run(`Reading exact version ${target.version}…`, async check => {
      ready(); publish({ ...view, record: null });
      const value = await transport.read(target, lifetime.authorize('read', target)); check(); ready(); arm(value.observation.expiresAt);
      publish({ ...view, record: value, message: `Exact record ${target.id}, version ${target.version}, checked.` });
    }); },
    refreshReferences() { if (active) return; try { rows(); publish({ ...view, message: 'Saved references refreshed. No request was sent.', focus: ++sequence }); }
      catch { active = null; lifetime.invalidate(); publish({ ...view, phase: 'expired', message: expiredMessage }); } },
    lookup(reference: FinancialPolicyReference) { return run('Checking one original financial-policy result…', async check => {
      ready(); if (!view.rows.some(value => financialSame(value.reference, reference))) throw new FinancialPolicyClientError('input');
      row(reference, { state: 'checking', message: 'Checking this original result…' });
      try {
        const result = await transport.lookup(reference, lifetime.authorize('lookup', reference)); check(); ready(); arm(result.observation.expiresAt);
        const receipt = memory.recorded(reference);
        row(reference, { state: receipt ? 'recorded' : 'not-recorded', receipt,
          message: result.receipt ? 'The service returned a matching immutable original receipt.' : 'No result was returned at this check. This does not cancel or fail the original request.' });
        publish({ ...view, message: result.receipt ? 'Original result recorded. Clearing this tab’s reminder is a separate action.' : 'Original result remains unconfirmed at this check.' });
      } catch (error) { check(); row(reference, { state: 'unconfirmed', message: 'The check could not be confirmed. The original reference remains stored.' }); throw error; }
    }); },
    clear(reference: FinancialPolicyReference) { return run('Clearing this tab’s exact reminder…', async check => {
      ready(); const value = view.rows.find(item => financialSame(item.reference, reference));
      if (!value?.receipt || value.state === 'cleared') throw new FinancialPolicyClientError('input');
      row(reference, { state: 'clearing' });
      try {
        await clearFinancialPolicyReminder(adapters.storage(), reference, value.receipt, () => { check(); ready(); return true; });
      } catch (error) {
        // The storage helper normalizes errors; recover current scope/expiry before publishing feedback.
        check(); ready(); throw error;
      }
      check(); ready();
      row(reference, { state: 'cleared', message: 'Only this tab’s matching reminder was cleared. The immutable original receipt remains visible during this observation.' });
      publish({ ...view, message: 'This tab’s exact reminder was cleared.' });
    }); },
    close() { suspend(); closed = true; memory.close(); lifetime.close(); subscribers.clear(); },
  };
}
export type FinancialPolicyWorkspaceController = ReturnType<typeof createFinancialPolicyWorkspaceController>;

function ContextSummary({ context }: { context: FinancialPolicyHttpContext }) {
  return <Panel title={context.kind === 'organization' ? 'Current budget configuration' : 'Current responsibility context'}>
    <div className="financial-policy-status"><StatusBadge tone="blue">Configuration only</StatusBadge><span>{context.configurationVisibility === 'references_only' ? 'References visible to Operations' : 'Full configuration review'}</span></div>
    <p className="review-note">This saves configuration. It does not authorize spending or make funds available.</p>
    <dl className="financial-policy-facts"><div><dt>Current accepted configuration</dt><dd>{context.control?.accepted
      ? context.configurationVisibility === 'full' ? <ButtonLink href={financialPolicyVersionPath(null, context.control.accepted)} secondary>{context.control.accepted.id} · version {context.control.accepted.version}</ButtonLink>
        : `${context.control.accepted.id} · version ${context.control.accepted.version}` : context.control ? 'None accepted' : 'Unavailable'}</dd></div>
      <div><dt>Balance and exposure</dt><dd>Unavailable</dd></div><div><dt>Budget control</dt><dd>{context.control ? `Generation ${context.control.generation}` : 'Unavailable'}</dd></div>
      <div><dt>Observation expires</dt><dd>{context.observation.expiresAt} UTC</dd></div></dl>
    {context.asset && <dl className="financial-policy-facts"><div><dt>Configuration asset</dt><dd>Solana devnet · 6 decimals<code>{context.asset.pin.key}</code></dd></div>
      <div><dt>Mint</dt><dd><code>{context.asset.mint}</code></dd></div><div><dt>Token program</dt><dd><code>{context.asset.tokenProgram}</code></dd></div><div><dt>Network genesis</dt><dd><code>{context.asset.genesis}</code></dd></div></dl>}
    <h3>Configuration blockers</h3><ul>{context.blockers.map(blocker => <li key={blocker}>{financialPolicyLabel(blocker)}</li>)}</ul>
    {context.documents.map(document => <FinancialPolicyDocumentText key={`${document.reference.id}:${document.reference.version}`} document={document}/>)}
  </Panel>;
}
export function FinancialPolicyWorkspaceView({ target = null, ...props }: FinancialPolicyWorkspaceAdapters & { target?: FinancialPolicyReadTarget | null }) {
  const latest = useRef(props); latest.current = props;
  const controllerRef = useRef<FinancialPolicyWorkspaceController | null>(null);
  const [controller] = useState(() => createFinancialPolicyWorkspaceController(props, () => Boolean(controllerRef.current?.matches(latest.current)) && !document.hidden));
  controllerRef.current = controller;
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot), motion = useMotion();
  const [showPending, setShowPending] = useState(false);
  const feedback = useRef<HTMLDivElement>(null), lastFocus = useRef(0);
  const key = financialPolicyBootstrapKey(props.bootstrap), targetKey = target ? JSON.stringify(target) : '';
  const displayExpired = view.context !== null && !controller.fresh();
  const scopeLost = view.visible && !controller.current();
  useLayoutEffect(() => {
    controller.configure(props);
    const visibility = () => document.hidden ? controller.suspend() : controller.activate();
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); controller.suspend(); };
  }, [controller, key, props.currentBootstrap, props.getToken, props.fetch, props.storage, props.wall, props.monotonic, targetKey]);
  useLayoutEffect(() => { if (view.visible && view.focus > lastFocus.current && feedback.current) {
    lastFocus.current = view.focus; feedback.current.focus({ preventScroll: true });
  } }, [view.focus, view.visible]);
  useLayoutEffect(() => { if (displayExpired) controller.expireDisplay(); }, [controller, displayExpired]);
  useLayoutEffect(() => { if (scopeLost && !controller.current()) controller.suspend(); }, [controller, scopeLost]);
  useEffect(() => { if (!view.busy) { setShowPending(false); return; }
    const timer = setTimeout(() => setShowPending(true), 200); return () => clearTimeout(timer);
  }, [view.busy]);
  if (typeof document !== 'undefined' && document.hidden) return null;
  const safe = controller.matches(props) && view.visible && controller.current(), denied = safe && view.phase === 'denied';
  const context = safe && !displayExpired ? view.context : null;
  const back = financialPolicyCollectionPath(props.bootstrap.responsibilityId);
  return <div className="financial-policy" data-financial-motion={motion.mode} data-financial-pending={safe && view.busy ? 'true' : 'false'}>
    <PageHeading title={target ? `Financial policy · version ${target.version}` : 'Financial policies'}
      description={target ? 'Read the exact version, full policy texts and a separate current-state observation.' : 'Review configuration records and the results of original saved requests.'}
      action={<ButtonLink href={target ? back : props.bootstrap.responsibilityId ? `/app/responsibilities/${props.bootstrap.responsibilityId}` : '/app/organization'} secondary>{target ? 'Back to financial policies' : props.bootstrap.responsibilityId ? 'Back to responsibility' : 'Back to organization'}</ButtonLink>}/>
    <Panel title="Current access" action={!denied && <button type="button" className="button secondary" disabled={!safe || view.busy} onClick={() => void controller.refresh()}>
      <ActionLabel label={safe && view.busy && !context ? 'Checking context…' : 'Refresh current context'} reserve={['Checking context…', 'Refresh current context']}/></button>}>
      <div className="financial-policy-feedback" ref={feedback} tabIndex={-1}><span className="financial-policy-feedback-mark" aria-hidden="true">{safe && view.busy && showPending ? <BrandLoader/> : <span className="financial-policy-feedback-dot"/>}</span>
        <p role="status" aria-live="polite">{displayExpired ? expiredMessage : safe ? view.message : 'Opening the current financial-policy scope. No request has been sent.'}</p></div>
    </Panel>
    {context && <>
      {!target && <ContextSummary context={context}/>}
      {target ? <Panel title={`Exact record ${target.id}`} action={<button type="button" className="button secondary" disabled={view.busy} onClick={() => void controller.read(target)}>
        <ActionLabel label={view.busy ? 'Reading version…' : `Read version ${target.version}`} reserve={['Reading version…', `Read version ${target.version}`]}/></button>}>
        {view.record ? <FinancialPolicyReview response={view.record}/> : <p className="review-note">Read this exact version explicitly. No latest-version substitution is made.</p>}</Panel>
        : <><Panel title="Configuration records" action={<button type="button" className="button secondary" disabled={view.busy} onClick={() => void controller.index()}>
          Read first record page</button>}>
          {view.index ? <><div className="financial-policy-record-list">{view.index.items.map(({ policy }) => <article className="financial-policy-record-row" key={policy.reference.id}>
            <div><h3>{policy.record.id}</h3><p>Version {policy.reference.version} · {financialPolicyLabel(policy.projection.state)}</p>
              <p className="review-note">{policy.projection.currentRecord ? 'Current record version' : 'Historical record version'}{policy.record.kind === 'governance' && ` · ${policy.budgetConfiguration?.currentBudgetConfiguration ? 'Current accepted configuration' : 'Not the current accepted configuration'}`}</p></div>
            <ButtonLink href={financialPolicyVersionPath(props.bootstrap.responsibilityId, policy.reference)} secondary>Read version {policy.reference.version}</ButtonLink>
          </article>)}</div>{view.index.items.length === 0 && <p className="financial-policy-empty">No records returned for this page.</p>}
            {view.index.nextId && <button type="button" className="button secondary" disabled={view.busy} onClick={() => void controller.index(view.index!.nextId)}>Read next record page</button>}</>
            : <p className="review-note">Load a page explicitly to inspect saved configuration records.</p>}</Panel>
          {props.bootstrap.responsibilityId !== null && context.configurationVisibility === 'full' && <ButtonLink href="/app/organization/financial-policies" secondary>Organization financial policies</ButtonLink>}
          <FinancialPolicyRecoveryPanel rows={view.rows} blocked={view.storageBlocked} busy={view.busy} onRefresh={() => controller.refreshReferences()}
            onLookup={reference => void controller.lookup(reference)} onClear={reference => void controller.clear(reference)}/>
        </>}
    </>}
  </div>;
}

/** Native provider boundary. Responsibility acquisition is also an explicit read. */
export function FinancialPolicyWorkspace({ id = null, policyId, version }: { id?: string | null; policyId?: string; version?: string }) {
  const { session, getToken: workspaceToken } = useWorkspace(), auth = useAuth();
  const routeValid = id === null || IdSchema.safeParse(id).success;
  const allowed = routeValid && auth.isLoaded && auth.isSignedIn && Boolean(auth.userId && auth.orgId && auth.sessionId) &&
    session.actor.sessionId === auth.sessionId && session.actor.principalKind === 'human' && session.actor.environment === 'development' &&
    session.actor.roles.some(role => (id === null ? ['owner', 'finance'] : ['owner', 'finance', 'operations']).includes(role));
  const query = useQuery({ queryKey: ['responsibility', id], enabled: false, queryFn: ({ signal }) => apiRequest(`/v1/responsibilities/${encodeURIComponent(id ?? '')}`,
    scopedResponsibilitySchema(session).refine(record => record.id === id), workspaceToken, { signal }), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const latest = useRef({ session, auth, record: query.data, error: query.isError }); latest.current = { session, auth, record: query.data, error: query.isError };
  const currentBootstrap = useCallback(() => { const value = latest.current; try {
    if (id !== null && (!value.record || value.error)) return null;
    return createFinancialPolicyBootstrap(value.session, value.auth, getApiBase(), id === null ? null : value.record!, id);
  } catch { return null; } }, [id]);
  const getToken = useCallback((options: { organizationId: string; skipCache: true }) => auth.getToken(options), [auth.getToken]);
  const fetcher = useCallback((url: string, init: RequestInit) => fetch(url, init), []);
  const storage = useCallback((): FinancialPolicyStorage | null => browserRecoveryStorage(), []);
  const parsedVersion = version !== undefined && /^[1-9]\d*$/.test(version) ? FinancialPolicyVersionSchema.safeParse(Number(version)) : null;
  if (!allowed || (policyId !== undefined && (!IdSchema.safeParse(policyId).success || !parsedVersion?.success)))
    return <Alert title="Financial-policy access unavailable"><p>A valid development route and current owner, finance or scoped Operations access are required.</p></Alert>;
  const bootstrap = currentBootstrap();
  if (!bootstrap && id === null) return <Alert title="Current organization access is unavailable"><p>Return to your organization workspace to check the current session.</p><ButtonLink href="/app/organization" secondary>Back to organization</ButtonLink></Alert>;
  if (!bootstrap) return <><PageHeading title="Financial policies"/><Panel title="Responsibility access">
    <p className="review-note">Check this responsibility before opening its financial-policy context.</p>
    {query.isFetching ? <LoadingState label="Checking responsibility access"/> : <button type="button" className="button secondary" onClick={() => void query.refetch()}>Check responsibility access</button>}
    {query.isError && <p role="status">Current responsibility access could not be verified. No financial-policy request was sent.</p>}
  </Panel></>;
  const target: FinancialPolicyReadTarget | null = policyId && parsedVersion?.success
    ? { kind: id === null ? 'governance' : 'draft', responsibilityId: id, id: policyId, version: parsedVersion.data, recordHash: null } : null;
  return <FinancialPolicyWorkspaceView bootstrap={bootstrap} currentBootstrap={currentBootstrap} getToken={getToken} fetch={fetcher} storage={storage} target={target}/>;
}
