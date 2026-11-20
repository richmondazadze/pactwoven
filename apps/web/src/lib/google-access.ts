import { z } from 'zod';
import type { Session } from '@pactwoven/contracts';
import { requestApiAtBase, RequestError, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';

export const GOOGLE_CALLBACK_PATH = '/app/settings/connections/google/callback';
export const GOOGLE_SETTINGS_PATH = '/app/settings/connections/google';
export const GOOGLE_TEST_EMAIL = 'richverseecotech@gmail.com';
export const GOOGLE_CALLBACK_KIND = 'pactwoven-google-callback';
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const Reference = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const Name = z.string().trim().min(1).max(300);
const Instant = z.iso.datetime({ offset: true });
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const EventFields = { eventName: Name, calendarName: Name, startsAt: Instant, endsAt: Instant };
const ConsentStatus = z.enum(['prepared', 'approved', 'active', 'revoked']);
const ConsentFields = { id: Id, version: Version, rootTitle: Name, expiresAt: Instant, status: ConsentStatus };
export const GoogleOverviewSchema = z.strictObject({
  availability: z.enum(['ready', 'unavailable']),
  connections: z.array(z.strictObject({ id: Id, version: Version, email: z.literal(GOOGLE_TEST_EMAIL), status: z.enum(['connected', 'refreshing', 'revoked', 'unavailable']) })).max(100),
  tasks: z.array(z.strictObject({ reference: Reference, title: Name, siteName: Name })).max(500),
  consents: z.array(z.union([
    z.strictObject({ ...ConsentFields, details: z.literal('available'), ...EventFields }),
    z.strictObject({ ...ConsentFields, details: z.literal('unavailable'), preparedAt: Instant }),
  ])).max(500),
}).refine(value => new Set(value.connections.map(item => item.id)).size === value.connections.length && new Set(value.tasks.map(item => item.reference)).size === value.tasks.length && new Set(value.consents.map(item => item.id)).size === value.consents.length, 'Records must be unique');
export const GoogleBaselineSchema = z.strictObject({ reference: Reference, ...EventFields, validUntil: Instant }).refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt), 'Event end must follow start');
export const GoogleReviewSchema = z.strictObject({
  id: Id, token: z.string().regex(/^[a-f0-9]{64}$/), rootTitle: Name, siteName: Name, accountEmail: z.literal(GOOGLE_TEST_EMAIL), ...EventFields,
  purpose: z.string().trim().min(1).max(1000), expiresAt: Instant, confirmBy: Instant,
  permission: z.literal('read_single_calendar_event'), outboundEffects: z.literal('forbidden'), continuesAfterSignOut: z.literal(true),
});
// Compatibility with the private gateway receipt. Exact provider identifiers are
// validated here but never rendered, cached or copied into a URL.
const Opaque = z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const GoogleReceiptSchema = z.strictObject({ id: Id, rootTitle: Name, accountEmail: z.literal(GOOGLE_TEST_EMAIL), target: z.strictObject({ kind: z.literal('calendar_change'), calendarId: Opaque, eventId: Opaque, expectedEtag: Opaque }), expiresAt: Instant, status: ConsentStatus });
export const GoogleStartSchema = z.strictObject({ authorizationUrl: z.string().max(8192) });
export const GoogleConnectedSchema = z.strictObject({ connectionId: Id });
export const GoogleRecoverySchema = z.strictObject({ status: z.enum(['pending', 'reserved', 'failed', 'connected', 'refreshing', 'revoked', 'unavailable']), connectionId: Id.nullable() }).refine(value => !['connected', 'refreshing', 'revoked'].includes(value.status) || value.connectionId !== null);
export const GoogleRevokedSchema = z.strictObject({ status: z.literal('revoked') });
export type GoogleOverview = z.infer<typeof GoogleOverviewSchema>;
export type GoogleBaseline = z.infer<typeof GoogleBaselineSchema>;
export type GoogleReview = z.infer<typeof GoogleReviewSchema>;
export type GoogleReceipt = z.infer<typeof GoogleReceiptSchema>;

const paths = new Set(['overview', 'connect', 'callback', 'recover', 'revoke', 'event-baseline', 'consent/prepare-event', 'consent/confirm', 'consent/recover', 'consent/revoke']);
export function googleRequest<T>(path: string, schema: z.ZodType<T>, getToken: TokenSource, options: ApiRequestOptions = {}): Promise<T> {
  if (!paths.has(path)) return Promise.reject(new RequestError('INVALID_PATH', 'This connection request is not supported.'));
  const base = getNativeApiBase();
  return requestApiAtBase(base, `/v1/google/${path}`, schema, getToken, { ...options, body: options.body ?? {}, beforeDispatch: () => {
    if (base !== getNativeApiBase()) throw new RequestError('SCOPE_CHANGED', 'The connection service changed. Refresh this page.');
    options.beforeDispatch?.();
  } });
}
export function canManageGoogle(session: Session) { return session.actor.principalKind === 'human' && session.actor.roles.some(role => role === 'owner' || role === 'operations'); }
export function googleScope(session: Session) { const { correlationId: _correlationId, ...actor } = session.actor; return JSON.stringify([actor, session.organization.authorityEpoch, getNativeApiBase()]); }

export function validateGoogleAuthorizationUrl(value: string, origin: string) {
  const url = new URL(value), params = url.searchParams;
  const allowed = new Set(['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'access_type', 'prompt', 'include_granted_scopes', 'login_hint']);
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash ||
    [...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1) ||
    params.get('redirect_uri') !== origin + GOOGLE_CALLBACK_PATH || params.get('response_type') !== 'code' ||
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(params.get('client_id') ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.get('state') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') ||
    params.get('code_challenge_method') !== 'S256' || params.get('access_type') !== 'offline' || params.get('include_granted_scopes') !== 'false' ||
    params.get('prompt') !== 'consent' || params.get('login_hint') !== GOOGLE_TEST_EMAIL ||
    params.get('scope')?.split(' ').sort().join(' ') !== ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly'].sort().join(' ')) {
    throw new RequestError('RESPONSE_UNVERIFIED', 'The Google connection address could not be verified.');
  }
  return { url: url.href, state: params.get('state')! };
}
const CallbackSchema = z.discriminatedUnion('result', [
  z.strictObject({ kind: z.literal(GOOGLE_CALLBACK_KIND), result: z.literal('code'), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(8192).regex(/^[^\u0000-\u001f\u007f]+$/) }),
  z.strictObject({ kind: z.literal(GOOGLE_CALLBACK_KIND), result: z.literal('cancelled'), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
]);
/** One attempt, one exact opener, one response. No code is retained by the gate. */
export class GooglePopupGate {
  private consumed = false;
  constructor(readonly state: string, private readonly origin: string, private readonly popup: MessageEventSource, private readonly expiresAt: number) {}
  consume(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, now = Date.now()) {
    if (this.consumed || now >= this.expiresAt || event.origin !== this.origin || event.source !== this.popup) return null;
    const parsed = CallbackSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.state !== this.state) return null;
    this.consumed = true;
    return parsed.data;
  }
}
export function validCalendarEventLink(value: string) {
  try {
    const url = new URL(value);
    if (value.length > 4096 || url.origin !== 'https://calendar.google.com' || url.username || url.password || url.hash) return false;
    if (/^\/calendar(?:\/u\/\d+)?\/r\/eventedit\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search) return true;
    return /^\/calendar\/(?:event|render)$/.test(url.pathname) && url.searchParams.getAll('eid').length === 1 && /^[A-Za-z0-9_=-]+$/.test(url.searchParams.get('eid') ?? '') &&
      [...url.searchParams.keys()].every(key => ['eid', 'action', 'ctz'].includes(key)) && (!url.searchParams.has('action') || url.searchParams.get('action') === 'VIEW');
  } catch { return false; }
}
export function reviewMatchesSelection(review: GoogleReview, baseline: GoogleBaseline, task: GoogleOverview['tasks'][number], purpose: string, durationMinutes: number, now = Date.now()) {
  return review.rootTitle === task.title && review.siteName === task.siteName && review.purpose === purpose.trim() &&
    review.eventName === baseline.eventName && review.calendarName === baseline.calendarName && review.startsAt === baseline.startsAt && review.endsAt === baseline.endsAt &&
    Date.parse(baseline.validUntil) > now && Date.parse(review.confirmBy) > now && Date.parse(review.confirmBy) <= Date.parse(review.expiresAt) &&
    Date.parse(review.expiresAt) > now && Date.parse(review.expiresAt) <= now + durationMinutes * 60_000 + 5000;
}
export function receiptMatchesReview(receipt: GoogleReceipt, review: GoogleReview) { return receipt.id === review.id && receipt.rootTitle === review.rootTitle && receipt.accountEmail === review.accountEmail && receipt.expiresAt === review.expiresAt; }
export function googleFailure(error: unknown) {
  if (error instanceof RequestError) {
    if (error.status === 401 || error.status === 403) return 'Your current access could not be verified. Sign in again or ask your workspace owner to review your access.';
    if (['API_NOT_CONFIGURED', 'SETUP_REQUIRED', 'GOOGLE_INTEGRATION_REQUIRED'].includes(error.code) || error.status === 404) return 'Google Calendar access is not available in this workspace yet. Check again after setup is complete.';
    if (error.code === 'RESPONSE_UNVERIFIED') return 'The service returned a result that could not be verified. No outcome has been assumed.';
    if (error.code === 'SCOPE_CHANGED') return 'Your workspace or service changed. Refresh this page before continuing.';
  }
  // Never render provider errors, authorization values, IDs, or arbitrary API text.
  return 'The response could not be confirmed. Check the original request’s status before starting again.';
}
export function googleDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
