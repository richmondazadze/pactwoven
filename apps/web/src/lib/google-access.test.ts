import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestError } from './api';
import { GOOGLE_CALLBACK_KIND, GOOGLE_CALLBACK_PATH, GOOGLE_TEST_EMAIL, GoogleBaselineSchema, GoogleOverviewSchema, GooglePopupGate, GoogleReviewSchema, googleCallbackChannelName, googleFailure, googleRequest, receiptMatchesReview, reviewMatchesSelection, validCalendarEventLink, validateGoogleAuthorizationUrl } from './google-access';

const origin = 'https://pactwoven.vercel.app', state = 'a'.repeat(43);
function authUrl() { const url = new URL('https://accounts.google.com/o/oauth2/v2/auth'); url.search = new URLSearchParams({ client_id: 'test.apps.googleusercontent.com', redirect_uri: origin + GOOGLE_CALLBACK_PATH, response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly', state, code_challenge: 'b'.repeat(43), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', login_hint: GOOGLE_TEST_EMAIL }).toString(); return url; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Google authorization boundary', () => {
  it('accepts the fixed provider, exact callback, read scopes and S256 flow', () => expect(validateGoogleAuthorizationUrl(authUrl().href, origin)).toEqual({ url: authUrl().href, state }));
  it.each(['redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'client_id', 'access_type', 'prompt', 'include_granted_scopes', 'login_hint', 'response_type'])('rejects changed %s', key => { const url = authUrl(); url.searchParams.set(key, 'untrusted'); expect(() => validateGoogleAuthorizationUrl(url.href, origin)).toThrow(); });
  it('rejects wrong hosts, extra/duplicated parameters, credentials and fragments', () => {
    for (const transform of [(u: URL) => { u.hostname = 'accounts.google.com.attacker.test'; }, (u: URL) => { u.searchParams.set('client_secret', 'synthetic-secret'); }, (u: URL) => { u.searchParams.append('state', state); }, (u: URL) => { u.username = 'name'; }, (u: URL) => { u.hash = 'fragment'; }]) { const url = authUrl(); transform(url); expect(() => validateGoogleAuthorizationUrl(url.href, origin)).toThrow(); }
  });
  it('requires exact source, origin, state and shape before consuming one message', () => {
    const source = {} as Window, gate = new GooglePopupGate(state, origin, source, 2000), data = { kind: GOOGLE_CALLBACK_KIND, result: 'code', state, code: 'synthetic-code' };
    for (const event of [{ origin: 'https://foreign.test', source, data }, { origin, source: {} as Window, data }, { origin, source, data: { ...data, state: 'b'.repeat(43) } }, { origin, source, data: { ...data, accessToken: 'must-not-accept' } }, { origin, source, data: { ...data, code: '\n' } }]) expect(gate.consume(event, 1000)).toBeNull();
    expect(gate.consume({ origin, source, data }, 1000)?.result).toBe('code');
    expect(gate.consume({ origin, source, data }, 1000)).toBeNull();
  });
  it('rejects expired responses and consumes cancellation once', () => { const source = {} as Window, event = { origin, source, data: { kind: GOOGLE_CALLBACK_KIND, result: 'cancelled', state } }; expect(new GooglePopupGate(state, origin, source, 1000).consume(event, 1000)).toBeNull(); const gate = new GooglePopupGate(state, origin, source, 2000); expect(gate.consume(event, 1000)?.result).toBe('cancelled'); expect(gate.consume(event, 1000)).toBeNull(); });
  it.each(['window', 'channel'])('consumes one result when %s wins the two-path race', first => {
    const source = {} as Window, gate = new GooglePopupGate(state, origin, source, 2000), event = { origin, source, data: { kind: GOOGLE_CALLBACK_KIND, result: 'code', state, code: 'synthetic-code' } };
    expect(first === 'window' ? gate.consume(event, 1000) : gate.consumeChannel(event, 1000)).not.toBeNull();
    expect(gate.consume(event, 1000)).toBeNull(); expect(gate.consumeChannel(event, 1000)).toBeNull();
  });
  it('channel fallback still requires exact origin, original state, strict shape and unexpired gate', () => {
    const source = {} as Window, gate = new GooglePopupGate(state, origin, source, 2000), event = { origin, data: { kind: GOOGLE_CALLBACK_KIND, result: 'code', state, code: 'synthetic-code' } };
    for (const value of [{ ...event, origin: 'https://foreign.test' }, { ...event, data: { ...event.data, state: 'z'.repeat(43) } }, { ...event, data: { ...event.data, unexpected: true } }]) expect(gate.consumeChannel(value, 1000)).toBeNull();
    expect(gate.consumeChannel(event, 2000)).toBeNull(); expect(gate.consume({ ...event, source: {} as Window }, 1000)).toBeNull();
    expect(gate.consumeChannel(event, 1000)?.result).toBe('code');
  });
  it('isolates channel namespaces by valid random original state', () => {
    expect(googleCallbackChannelName(state)).not.toBe(googleCallbackChannelName('b'.repeat(43)));
    for (const invalid of ['', '../callback', state + 'a']) expect(() => googleCallbackChannelName(invalid)).toThrow();
  });
});
describe('named event permission', () => {
  it.each(['https://calendar.google.com/calendar/event?eid=ZXZlbnQ', 'https://calendar.google.com/calendar/render?action=VIEW&eid=ZXZlbnQ', 'https://calendar.google.com/calendar/u/0/r/eventedit/ZXZlbnQ'])('accepts specific Google event link %s', link => expect(validCalendarEventLink(link)).toBe(true));
  it.each(['https://calendar.google.com', 'http://calendar.google.com/calendar/event?eid=abc', 'https://calendar.google.com.attacker.test/calendar/event?eid=abc', 'https://calendar.google.com/calendar/event?eid=abc&eid=def', 'https://calendar.google.com/calendar/event?eid=abc&redirect=https://foreign.test', 'https://calendar.google.com/calendar/event?eid=abc#fragment', 'https://user:secret@calendar.google.com/calendar/event?eid=abc', 'https://calendar.google.com/calendar/render?action=TEMPLATE&eid=abc'])('rejects broad or unsafe link %s', link => expect(validCalendarEventLink(link)).toBe(false));
  const now = Date.parse('2026-11-18T18:00:00Z'), at = (offset: number) => new Date(now + offset).toISOString();
  const baseline = { reference: 'baseline_ref', eventName: 'Delivery check', calendarName: 'Operations', startsAt: at(3600000), endsAt: at(7200000), validUntil: at(20000) };
  const task = { reference: 'task_ref', title: 'Prepare delivery', siteName: 'North studio' };
  const review = { id: 'review_ref', token: 'a'.repeat(64), rootTitle: task.title, siteName: task.siteName, accountEmail: GOOGLE_TEST_EMAIL as typeof GOOGLE_TEST_EMAIL, eventName: baseline.eventName, calendarName: baseline.calendarName, startsAt: baseline.startsAt, endsAt: baseline.endsAt, purpose: 'Read the delivery time', confirmBy: at(15000), expiresAt: at(3600000), permission: 'read_single_calendar_event' as const, outboundEffects: 'forbidden' as const, continuesAfterSignOut: true as const };
  it('requires current named details, task, purpose and bounded expiry', () => {
    expect(reviewMatchesSelection(review, baseline, task, review.purpose, 60, now)).toBe(true);
    for (const change of [{ eventName: 'Other event' }, { calendarName: 'Other calendar' }, { rootTitle: 'Other task' }, { siteName: 'Other site' }, { purpose: 'Different purpose' }, { expiresAt: at(3606000) }, { confirmBy: at(-1) }, { startsAt: at(0) }]) expect(reviewMatchesSelection({ ...review, ...change }, baseline, task, review.purpose, 60, now)).toBe(false);
    expect(reviewMatchesSelection(review, { ...baseline, validUntil: at(-1) }, task, review.purpose, 60, now)).toBe(false);
  });
  it('rejects unrecognized/private provider fields, invalid dates and broad permissions', () => {
    expect(GoogleReviewSchema.safeParse(review).success).toBe(true);
    for (const change of [{ accessToken: 'secret' }, { permission: 'read_all_events' }, { continuesAfterSignOut: false }, { expiresAt: 'tomorrow' }, { accountEmail: 'other@example.test' }]) expect(GoogleReviewSchema.safeParse({ ...review, ...change }).success).toBe(false);
    expect(GoogleBaselineSchema.safeParse({ ...baseline, endsAt: baseline.startsAt }).success).toBe(false);
    expect(GoogleOverviewSchema.safeParse({ availability: 'ready', connections: [], tasks: [task, task], consents: [] }).success).toBe(false);
  });
  it('binds the private receipt to the original displayed review', () => { const receipt = { id: review.id, rootTitle: review.rootTitle, accountEmail: GOOGLE_TEST_EMAIL as typeof GOOGLE_TEST_EMAIL, expiresAt: review.expiresAt, target: { kind: 'calendar_change' as const, calendarId: 'private-calendar', eventId: 'private-event', expectedEtag: 'private-revision' }, status: 'active' as const }; expect(receiptMatchesReview(receipt, review)).toBe(true); expect(receiptMatchesReview({ ...receipt, id: 'other' }, review)).toBe(false); expect(receiptMatchesReview({ ...receipt, expiresAt: at(999) }, review)).toBe(false); });
});
describe('private transport and errors', () => {
  it('uses the configured native host, POST body and no-store without retries', async () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test'); const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await googleRequest('callback', z.strictObject({ ok: z.boolean() }), async () => 'test-session', { body: { state, code: 'synthetic-code' } });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]).toMatchObject(['https://native.example.test/v1/google/callback', { method: 'POST', cache: 'no-store', credentials: 'omit', body: JSON.stringify({ state, code: 'synthetic-code' }) }]);
  });
  it('rejects query/path injection and service changes during token acquisition', async () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const path of ['callback?code=secret', '../tasks', '/v1/google/connect']) await expect(googleRequest(path, z.unknown(), async () => 'token')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(googleRequest('overview', z.unknown(), async () => { vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://other.test'); return 'token'; })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry or render raw provider messages', async () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test'); const fetcher = vi.fn(async () => { throw new Error('synthetic-private-code'); }); vi.stubGlobal('fetch', fetcher);
    await expect(googleRequest('callback', z.unknown(), async () => 'token')).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledOnce();
    expect(googleFailure(new RequestError('PROVIDER_ERROR', 'synthetic-private-code'))).not.toContain('synthetic-private-code');
    expect(googleFailure(new RequestError('SETUP_REQUIRED', 'synthetic-private-code', 503))).toContain('not available');
  });
});
