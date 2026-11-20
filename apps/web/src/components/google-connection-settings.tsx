'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { RequestError, type ApiRequestOptions } from '../lib/api';
import {
  GOOGLE_TEST_EMAIL, GoogleBaselineSchema, GoogleConnectedSchema, GoogleOverviewSchema, GooglePopupGate,
  GoogleReceiptSchema, GoogleRecoverySchema, GoogleReviewSchema, GoogleRevokedSchema, GoogleStartSchema,
  canManageGoogle, googleDate, googleFailure, googleRequest, googleScope, receiptMatchesReview,
  reviewMatchesSelection, validCalendarEventLink, validateGoogleAuthorizationUrl,
  type GoogleBaseline, type GoogleOverview, type GoogleReview,
} from '../lib/google-access';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, LoadingState, PageHeading, Panel, StatusBadge } from './ui';
import { Icon } from './icon';

type Preparation = { body: { baselineReference: string; taskReference: string; purpose: string; durationMinutes: number }; key: string; baseline: GoogleBaseline; task: GoogleOverview['tasks'][number] };
type OAuthAttempt = { state: string; gate: GooglePopupGate; popup: Window; exchanged: boolean };

export function GoogleConnectionSettings() {
  const { session } = useWorkspace();
  return <GoogleConnectionScope key={googleScope(session)}/>;
}

function GoogleConnectionScope() {
  const { session, getToken } = useWorkspace();
  const allowed = canManageGoogle(session), scope = googleScope(session);
  const currentScope = useRef(scope); currentScope.current = scope;
  const life = useRef<{ controller: AbortController; live: boolean }>({ controller: new AbortController(), live: true });
  const lock = useRef(false), attempt = useRef<OAuthAttempt | null>(null), popup = useRef<Window | null>(null);
  const [overview, setOverview] = useState<GoogleOverview | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [oauthState, setOauthState] = useState<'idle' | 'waiting' | 'unknown'>('idle');
  const [connectionId, setConnectionId] = useState(''), [eventLink, setEventLink] = useState('');
  const [baseline, setBaseline] = useState<GoogleBaseline | null>(null), [taskReference, setTaskReference] = useState('');
  const [purpose, setPurpose] = useState(''), [durationMinutes, setDurationMinutes] = useState(60);
  const [preparation, setPreparation] = useState<Preparation | null>(null), [review, setReview] = useState<GoogleReview | null>(null);
  const [confirmationUnknown, setConfirmationUnknown] = useState(false), [checked, setChecked] = useState(false);
  const confirmationKey = useRef<string | null>(null);
  const [canFinishOriginal, setCanFinishOriginal] = useState(false);
  const [now, setNow] = useState(Date.now());
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const ready = overview?.availability === 'ready';
  const connection = overview?.connections.find(item => item.id === connectionId && item.status === 'connected');
  const connections = overview?.connections.filter(item => item.status !== 'revoked') ?? [];
  const task = overview?.tasks.find(item => item.reference === taskReference);
  const blocked = Boolean(busy) || oauthState !== 'idle';
  const expired = Boolean(review && (Date.parse(review.confirmBy) <= now || Date.parse(review.expiresAt) <= now));
  const hasTimedConsents = Boolean(overview?.consents.some(item => item.status !== 'revoked'));

  function guard(manage = false) {
    if (!life.current.live || currentScope.current !== scope) throw new RequestError('SCOPE_CHANGED', 'Workspace changed.');
    if (manage && !allowed) throw new RequestError('ACCESS_DENIED', 'Access denied.', 403);
    life.current.controller.signal.throwIfAborted();
    return undefined;
  }
  async function request<T>(path: string, schema: z.ZodType<T>, options: ApiRequestOptions = {}, manage = false) {
    guard(manage);
    const owner = life.current;
    const check = () => { if (life.current !== owner || !owner.live) throw new RequestError('SCOPE_CHANGED', 'Workspace changed.'); guard(manage); return undefined; };
    const value = await googleRequest(path, schema, getToken, { ...options, signal: owner.controller.signal, beforeDispatch: () => { check(); options.beforeDispatch?.(); } });
    check();
    guard(manage);
    return value;
  }
  async function action(name: string, work: () => Promise<void>, onError?: (failure: unknown) => void) {
    if (lock.current || !life.current.live) return;
    const owner = life.current;
    lock.current = true; setBusy(name); setError(''); setNotice('');
    try { await work(); } catch (failure) { if (life.current === owner && owner.live) { setError(googleFailure(failure)); onError?.(failure); } }
    finally { if (life.current === owner && owner.live) { lock.current = false; setBusy(''); } }
  }
  async function load() {
    const owner = life.current;
    setLoading(true); setOverview(null);
    try {
      const value = await request('overview', GoogleOverviewSchema);
      setOverview(value);
      setConnectionId(previous => value.connections.some(item => item.id === previous && item.status === 'connected') ? previous : value.connections.find(item => item.status === 'connected')?.id ?? '');
    } finally { if (life.current === owner && owner.live) setLoading(false); }
  }
  async function refreshAfterOutcome() { try { await load(); } catch (failure) { if (life.current.live) setError(googleFailure(failure)); } }
  useLayoutEffect(() => {
    life.current = { controller: new AbortController(), live: true };
    lock.current = false;
    return () => { life.current.live = false; life.current.controller.abort(); popup.current?.close(); attempt.current = null; popup.current = null; };
  }, []);
  useEffect(() => { void action('Loading status', load); }, []); // Each verified authorization scope mounts separately.
  useEffect(() => { if (review) { setNow(Date.now()); reviewHeading.current?.focus(); } }, [review?.id]);
  useEffect(() => {
    if (!review && !baseline && oauthState === 'idle' && !hasTimedConsents) return;
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      const pending = attempt.current;
      if (pending && !pending.exchanged && pending.popup.closed) { attempt.current = null; popup.current = null; setOauthState('idle'); setNotice('The Google window closed before a result was received. You can start again.'); }
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [review, baseline, oauthState, hasTimedConsents]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      const pending = attempt.current;
      if (!pending || lock.current) return;
      const response = pending.gate.consume(event);
      if (!response) return;
      pending.popup.close(); popup.current = null;
      if (response.result === 'cancelled') { attempt.current = null; setOauthState('idle'); setNotice('Google access was not connected. You can start again when you are ready.'); return; }
      pending.exchanged = true;
      let code = response.code; response.code = '';
      if (event.data && typeof event.data === 'object') event.data.code = '';
      void action('Finishing connection', async () => {
        try { await request('callback', GoogleConnectedSchema, { body: { state: pending.state, code } }, true); }
        finally { code = ''; }
        attempt.current = null; setOauthState('idle'); setNotice('Google Calendar is connected. Choose an event before giving a task permission to read it.'); await refreshAfterOutcome();
      }, () => { code = ''; setOauthState('unknown'); });
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  });

  function connect() {
    if (blocked || lock.current || !ready || !allowed || review || preparation) return;
    const opened = window.open('about:blank', '_blank', 'popup,width=540,height=720');
    if (!opened) { setError('Allow pop-up windows for Pactwoven, then choose Connect Google Calendar again.'); return; }
    popup.current = opened;
    opened.document.title = 'Connecting to Google Calendar';
    opened.document.body.textContent = 'Preparing your Google Calendar connection…';
    void action('Opening Google', async () => {
      const result = await request('connect', GoogleStartSchema, {}, true);
      const verified = validateGoogleAuthorizationUrl(result.authorizationUrl, window.location.origin);
      if (opened.closed) throw new RequestError('POPUP_CLOSED', 'Window closed.');
      attempt.current = { state: verified.state, gate: new GooglePopupGate(verified.state, window.location.origin, opened, Date.now() + 300_000), popup: opened, exchanged: false };
      setOauthState('waiting'); opened.location.replace(verified.url);
    }, () => { opened.close(); popup.current = null; attempt.current = null; setOauthState('idle'); });
  }
  function recoverConnection() {
    const pending = attempt.current;
    if (!pending?.exchanged || blocked && oauthState !== 'unknown') return;
    void action('Checking connection', async () => {
      const result = await request('recover', GoogleRecoverySchema, { body: { state: pending.state } }, true);
      if (['connected', 'refreshing', 'revoked', 'failed'].includes(result.status)) {
        attempt.current = null; setOauthState('idle');
        setNotice(result.status === 'connected' ? 'The original connection completed. Choose an event to continue.' : result.status === 'failed' ? 'The original connection did not complete. You can connect again.' : 'The original connection was found. Review its current status below.');
        await refreshAfterOutcome();
      } else { setNotice('The original connection is still unresolved. Check its status again; the authorization code will not be sent twice.'); }
    });
  }
  function resetSelection() { setBaseline(null); setReview(null); setPreparation(null); setChecked(false); setConfirmationUnknown(false); confirmationKey.current = null; setCanFinishOriginal(false); }
  function readEvent() {
    if (blocked || !allowed || !ready || !connection || review || preparation || !validCalendarEventLink(eventLink.trim())) return;
    void action('Reading event details', async () => { const value = await request('event-baseline', GoogleBaselineSchema, { body: { connectionId: connection.id, eventLink: eventLink.trim(), allowRead: true } }, true);
      if (Date.parse(value.validUntil) <= Date.now()) throw new RequestError('RESPONSE_UNVERIFIED', 'Event details expired.');
      setBaseline(value); setEventLink(''); setNow(Date.now());
    });
  }
  function prepare(existing?: Preparation) {
    if (blocked || !allowed || !ready || !connection || review || (!existing && preparation)) return;
    if (!existing && (!baseline || !task || !purpose.trim() || Date.parse(baseline.validUntil) <= Date.now())) return;
    const pending = existing ?? { body: { baselineReference: baseline!.reference, taskReference: task!.reference, purpose: purpose.trim(), durationMinutes }, key: crypto.randomUUID(), baseline: baseline!, task: task! };
    if (Date.parse(pending.baseline.validUntil) <= Date.now()) { setPreparation(null); setBaseline(null); setError('The event details expired. Read the event again before preparing a review.'); return; }
    setPreparation(pending);
    void action('Preparing permission review', async () => {
      const value = await request('consent/prepare-event', GoogleReviewSchema, { body: pending.body, idempotencyKey: pending.key, beforeDispatch: () => { if (Date.parse(pending.baseline.validUntil) <= Date.now()) throw new RequestError('RESPONSE_UNVERIFIED', 'Event details expired.'); } }, true);
      if (!reviewMatchesSelection(value, pending.baseline, pending.task, pending.body.purpose, pending.body.durationMinutes)) throw new RequestError('RESPONSE_UNVERIFIED', 'Review does not match.');
      setReview(value); setChecked(false); setPreparation(null); confirmationKey.current = pending.key; setCanFinishOriginal(false); setNow(Date.now());
    });
  }
  async function acceptReceipt(value: z.infer<typeof GoogleReceiptSchema>, original: GoogleReview) {
    if (!receiptMatchesReview(value, original)) throw new RequestError('RESPONSE_UNVERIFIED', 'Receipt does not match.');
    if (value.status === 'active' || value.status === 'revoked') {
      setReview(null); setBaseline(null); setChecked(false); setConfirmationUnknown(false); confirmationKey.current = null; setCanFinishOriginal(false);
      setNotice(value.status === 'active' ? Date.parse(value.expiresAt) <= Date.now() ? 'The permission was issued, but its allowed time has now ended.' : 'Permission was issued. The task may read the selected event until the displayed expiry, including after you sign out. Check its current status below.' : 'This permission was revoked. It cannot read the event.');
      await refreshAfterOutcome();
    } else { setConfirmationUnknown(true); setCanFinishOriginal(true); setNotice('Permission has not been issued. You may finish the original permission while this review and session remain valid. A pending approval cannot activate after your session is revoked.'); }
  }
  function confirmReview() {
    if (blocked || !allowed || !review || confirmationUnknown && !canFinishOriginal || !checked || expired) return;
    const original = review, key = confirmationKey.current;
    if (!key) { setError('The original permission request is no longer available. Refresh current permissions before starting again.'); return; }
    setCanFinishOriginal(false);
    void action('Confirming permission', async () => {
      const receipt = await request('consent/confirm', GoogleReceiptSchema, { body: { reviewId: original.id, reviewToken: original.token, continuesAfterSignOut: true }, idempotencyKey: key, beforeDispatch: () => { if (Date.parse(original.confirmBy) <= Date.now() || Date.parse(original.expiresAt) <= Date.now()) throw new RequestError('REVIEW_EXPIRED', 'Review expired.'); } }, true);
      await acceptReceipt(receipt, original);
    }, () => setConfirmationUnknown(true));
  }
  function recoverReview() {
    if (blocked || !allowed || !review || !confirmationUnknown) return;
    const original = review;
    void action('Checking permission', async () => acceptReceipt(await request('consent/recover', GoogleReceiptSchema, { body: { reviewId: original.id } }, true), original));
  }
  function revokeConnection(id: string, version: number) {
    if (blocked || !allowed || review || preparation || !overview?.connections.some(item => item.id === id && item.version === version && item.status !== 'revoked')) return;
    void action('Disconnecting Google', async () => { await request('revoke', GoogleRevokedSchema, { body: { connectionId: id, expectedVersion: version } }, true); resetSelection(); setNotice('Google Calendar is disconnected from Pactwoven. Existing permissions cannot use this connection.'); await refreshAfterOutcome(); }, () => { setOverview(null); setBaseline(null); });
  }
  function revokeConsent(id: string, version: number) {
    if (blocked || !allowed || review || preparation || !overview?.consents.some(item => item.id === id && item.version === version && item.status === 'active')) return;
    void action('Revoking permission', async () => {
      const receipt = await request('consent/revoke', GoogleReceiptSchema, { body: { consentId: id, expectedVersion: version } }, true);
      if (receipt.id !== id || receipt.status !== 'revoked') throw new RequestError('RESPONSE_UNVERIFIED', 'Revocation not verified.');
      setNotice('The selected task permission is revoked.'); await refreshAfterOutcome();
    }, () => setOverview(null));
  }

  return <div className="google-settings">
    <PageHeading title="Google Calendar" description="Connect your account, then choose exactly which event a task may read." action={<button className="button secondary" disabled={blocked || Boolean(review) || Boolean(preparation)} onClick={() => { resetSelection(); void action('Refreshing status', load); }}><Icon name="repeat-arrows"/>Refresh status</button>}/>
    {error && <Alert title="Connection needs attention" tone="red"><p>{error}</p></Alert>}
    {notice && <Alert title="Connection update" tone="blue"><p>{notice}</p></Alert>}
    {!allowed && <Alert title="View access"><p>A workspace owner or operations member can connect Google Calendar and manage task permissions.</p></Alert>}
    {loading && !overview ? <LoadingState label="Checking Google Calendar access"/> : !overview || !ready ? <Panel title="Calendar access is not available yet"><p>Complete the workspace’s Google connection setup, then refresh its status here. No account or event has been assumed.</p></Panel> : <div className="google-layout">
      <div className="google-main">
        <Panel title="Connected account" action={<StatusBadge tone={connections.some(item => item.status === 'connected') ? 'green' : 'neutral'}>{connections.some(item => item.status === 'connected') ? 'Connected' : 'Not connected'}</StatusBadge>}>
          <div className="google-account"><span className="google-account-icon"><Icon name="calendar" size={28}/></span><div><h3>{GOOGLE_TEST_EMAIL}</h3><p>Google grants Calendar event read access. Pactwoven uses a separate, time-limited permission for each task and event.</p></div></div>
          {connections.map(item => <div className="google-account-row" key={item.id}><span>{item.status === 'connected' ? 'Ready to select an event' : item.status === 'refreshing' ? 'Connection is refreshing' : 'Connection needs attention'}</span><button className="button secondary" disabled={blocked || !allowed || Boolean(review) || Boolean(preparation)} onClick={() => revokeConnection(item.id, item.version)}>Disconnect</button></div>)}
          {connections.length === 0 && <button className="button" disabled={blocked || !allowed || Boolean(review) || Boolean(preparation)} onClick={connect}><Icon name="plug"/><ActionLabel label={busy === 'Opening Google' ? 'Opening Google…' : 'Connect Google Calendar'} reserve={['Connect Google Calendar', 'Opening Google…']}/></button>}
          {oauthState === 'waiting' && <div className="google-inline-status" role="status"><p>Continue in the Google window. Your task permissions will be reviewed here afterward.</p><button className="button secondary" disabled={Boolean(busy)} onClick={() => { popup.current?.close(); popup.current = null; attempt.current = null; setOauthState('idle'); setNotice('The connection window was closed. No task permission was granted.'); }}>Cancel connection</button></div>}
          {oauthState === 'unknown' && <div className="google-inline-status"><p>The connection result is unknown. Check the original attempt without sending its authorization code again.</p><button className="button" disabled={Boolean(busy)} onClick={recoverConnection}>Check original connection</button></div>}
        </Panel>
        {review ? <section className="panel google-review"><div className="panel-heading"><h2 ref={reviewHeading} tabIndex={-1}>Review event permission</h2><StatusBadge tone={confirmationUnknown ? 'amber' : 'blue'}>{confirmationUnknown ? 'Awaiting confirmation' : 'Ready for your review'}</StatusBadge></div><div className="panel-body">
          <h3 className="google-event-title">{review.eventName}</h3><p>{review.calendarName}</p>
          <dl className="review-key-values"><div><dt>Task</dt><dd>{review.rootTitle}</dd></div><div><dt>Site</dt><dd>{review.siteName}</dd></div><div><dt>Account</dt><dd>{review.accountEmail}</dd></div><div><dt>Event starts</dt><dd>{googleDate(review.startsAt)}</dd></div><div><dt>Event ends</dt><dd>{googleDate(review.endsAt)}</dd></div><div><dt>Permission ends</dt><dd>{googleDate(review.expiresAt)}</dd></div><div><dt>Purpose</dt><dd>{review.purpose}</dd></div><div><dt>Allowed action</dt><dd>Read this single Calendar event</dd></div><div><dt>Sending or editing</dt><dd>Not permitted</dd></div></dl>
          <p className="google-permission-note"><Icon name="shield-lock"/>After permission is successfully issued, this task can continue reading the selected event after you sign out, until the permission expires or is revoked. A pending approval requires your original session to remain valid.</p>
          {confirmationUnknown ? <><Alert title="Permission is not confirmed"><p>Check the original review. Do not submit another approval or assume the task can read this event.</p></Alert><div className="actions"><button className="button" disabled={blocked || !allowed} onClick={recoverReview}>Check original permission</button>{canFinishOriginal && !expired && <button className="button secondary" disabled={blocked || !allowed} onClick={confirmReview}>Finish original permission</button>}{canFinishOriginal && expired && <button className="button secondary" disabled={blocked} onClick={() => { resetSelection(); void action('Refreshing permissions', load); }}>View current permissions</button>}</div>{expired && <p className="review-note">The review window has expired. It cannot be confirmed here. Check the original permission, then inspect its status in the current permissions list. Only active permissions can be revoked.</p>}</> : <>
            {expired ? <Alert title="This review expired"><p>Select the event again to get current details before approving permission.</p></Alert> : <label className="google-consent-check"><input type="checkbox" checked={checked} disabled={blocked || !allowed} onChange={event => setChecked(event.target.checked)}/><span>I approve this event, task, purpose and expiry, including continued reading after sign-out once permission is issued.</span></label>}
            <div className="actions"><button className="button" disabled={blocked || !allowed || !checked || expired} onClick={confirmReview}><ActionLabel label={busy === 'Confirming permission' ? 'Confirming permission…' : 'Confirm event permission'} reserve={['Confirm event permission', 'Confirming permission…']}/></button><button className="button secondary" disabled={blocked} onClick={resetSelection}>{expired ? 'Select event again' : 'Back to event selection'}</button></div><p className="review-note">Confirm before {googleDate(review.confirmBy)}. Times use your device’s time zone.</p>
          </>}
        </div></section> : connection && <Panel title="Choose an event for a task">
          {baseline ? <><div className="google-selected-event"><Icon name="calendar" size={24}/><div><h3>{baseline.eventName}</h3><p>{baseline.calendarName}</p><p>{googleDate(baseline.startsAt)} — {googleDate(baseline.endsAt)}</p></div></div>
            {Date.parse(baseline.validUntil) <= now && <Alert title="Event details expired"><p>Read the event again to prepare a current permission review.</p></Alert>}
            <div className="google-fields"><label>Task<select value={taskReference} disabled={blocked || !allowed || Boolean(preparation)} onChange={event => setTaskReference(event.target.value)}><option value="">Choose a task</option>{overview.tasks.map(item => <option key={item.reference} value={item.reference}>{item.title} — {item.siteName}</option>)}</select></label>
              {overview.tasks.length === 0 && <p className="review-note">No eligible task is available. Create work with the required authority, then return here.</p>}
              <label>Why this task needs the event<textarea value={purpose} maxLength={1000} rows={3} disabled={blocked || !allowed || Boolean(preparation)} onChange={event => setPurpose(event.target.value)} placeholder="Describe the specific information the task needs."/></label>
              <label>Permission duration<select value={durationMinutes} disabled={blocked || !allowed || Boolean(preparation)} onChange={event => setDurationMinutes(Number(event.target.value))}><option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option><option value={1440}>24 hours</option></select></label></div>
            {preparation ? <div className="google-inline-status"><p>{busy === 'Preparing permission review' ? 'Preparing your permission review…' : 'The review preparation is unresolved. Recover the same preparation before creating another one.'}</p><button className="button" disabled={blocked || !allowed} onClick={() => prepare(preparation)}>Check same preparation</button></div> : <div className="actions"><button className="button" disabled={blocked || !allowed || !task || !purpose.trim() || Date.parse(baseline.validUntil) <= now} onClick={() => prepare()}>Review event permission</button><button className="button secondary" disabled={blocked} onClick={resetSelection}>Choose another event</button></div>}
          </> : <><p className="google-intro">Paste the link to a specific event from Google Calendar. Reading its details is a separate action before you grant any ongoing task permission.</p><div className="google-fields">
            {connections.filter(item => item.status === 'connected').length > 1 && <label>Connected account<select value={connectionId} disabled={blocked || !allowed} onChange={event => { setConnectionId(event.target.value); resetSelection(); }}>{connections.filter(item => item.status === 'connected').map((item, index) => <option key={item.id} value={item.id}>{item.email} — connection {index + 1}</option>)}</select></label>}
            <label>Google Calendar event link<input type="url" value={eventLink} autoComplete="off" spellCheck={false} maxLength={4096} disabled={blocked || !allowed} onChange={event => setEventLink(event.target.value)} aria-describedby="google-event-help" placeholder="https://calendar.google.com/calendar/event?eid=…"/></label><p id="google-event-help" className="review-note">Use an event from this account’s primary calendar. Shared calendars and all-day events are not supported yet. Open the event in Google Calendar and copy its event link.</p></div><button className="button" disabled={blocked || !allowed || !validCalendarEventLink(eventLink.trim())} onClick={readEvent}><ActionLabel label={busy === 'Reading event details' ? 'Reading event details…' : 'Read this event’s details'} reserve={['Read this event’s details', 'Reading event details…']}/></button></>}
        </Panel>}
        {overview.consents.length > 0 && <Panel title="Task permissions"><ul className="google-permissions">{overview.consents.map(item => { const isExpired = Date.parse(item.expiresAt) <= now; return <li key={item.id}><div><h3>{item.details === 'available' ? item.eventName : 'Event details unavailable'}</h3><p>{item.rootTitle}</p>{item.details === 'available' ? <p>{item.calendarName} · Ends {googleDate(item.expiresAt)}</p> : <><p>Event details were not retained for this permission. Its status remains available.</p><p>Prepared {googleDate(item.preparedAt)} · Ends {googleDate(item.expiresAt)}</p></>}<StatusBadge tone={item.status === 'active' && !isExpired ? 'green' : 'neutral'}>{item.status === 'revoked' ? 'Revoked' : isExpired ? 'Expired' : item.status === 'active' ? 'Active' : 'Not yet issued'}</StatusBadge></div>{item.status === 'active' && !isExpired && <button className="button secondary" disabled={blocked || !allowed || Boolean(review) || Boolean(preparation)} onClick={() => revokeConsent(item.id, item.version)}>Revoke permission</button>}</li>; })}</ul></Panel>}
      </div>
      <aside><Panel title="One event, one purpose"><div className="google-boundary"><Icon name="shield-lock" size={26}/><p>Connecting Google does not give every task access to your calendar.</p></div><ol className="google-steps"><li>Connect the selected Google account.</li><li>Read and verify one event’s details.</li><li>Review the task, purpose and expiry.</li><li>Confirm permission, then check that it is active.</li></ol><p className="review-note">This connection cannot send messages, create events or change your calendar.</p></Panel></aside>
    </div>}
    {busy && !loading && <p className="google-working" role="status" aria-live="polite"><span aria-hidden="true"/>{busy}…</p>}
  </div>;
}
