import { z } from 'zod';
import { CustodyApiRecoveryContextSchema, IdSchema, ResponsibilitySchema, SessionSchema,
  type CustodyApiRecoveryContext, type Responsibility, type Session } from '@pactwoven/contracts';
import { CustodyClientError, CustodyScopeSchema, custodySame, freezeCustody, type CustodyScope } from './custody-setup-contract';
import { parseCustodyResponseJson } from './custody-setup-transport';
import { getApiBase } from './config';

const BootstrapSchema = z.strictObject({ environment: z.literal('development'), apiBase: z.string(), userId: IdSchema,
  externalOrganizationId: IdSchema, sessionId: z.string().min(1).max(256), organizationId: IdSchema, actorId: IdSchema,
  organizationEpoch: z.number().int().nonnegative(), roles: z.array(z.string()), siteIds: z.array(IdSchema), actionSiteIds: z.array(IdSchema),
  responsibilityId: IdSchema, responsibilityVersion: z.number().int().positive(), siteId: IdSchema });
export type CustodyRecoveryBootstrap = z.infer<typeof BootstrapSchema>;
export type CustodyRecoveryAuth = { isLoaded?: boolean | undefined; isSignedIn?: boolean | undefined;
  userId?: string | null | undefined; orgId?: string | null | undefined; sessionId?: string | null | undefined };
const ended = () => new CustodyClientError('scope', 'Current owner access must be checked before opening saved setup requests.');
const unconfirmed = () => new CustodyClientError('unconfirmed', 'The owner access check could not be confirmed. Check again explicitly.');
const expired = () => new CustodyClientError('expired', 'The recovery access observation expired. Check current owner access again.');
export function canOpenCustodyRecovery(session: Session) {
  return session.actor.principalKind === 'human' && session.actor.environment === 'development' && session.actor.roles.includes('owner');
}
export function createCustodyRecoveryBootstrap(sessionInput: Session, auth: CustodyRecoveryAuth, base: string | null,
  responsibilityInput: Responsibility, routeId: string): CustodyRecoveryBootstrap {
  const session = SessionSchema.parse(sessionInput), responsibility = ResponsibilitySchema.parse(responsibilityInput);
  if (!auth.isLoaded || !auth.isSignedIn || !auth.userId || !auth.orgId || !auth.sessionId || !base || base !== getApiBase()
    || !canOpenCustodyRecovery(session) || session.actor.organizationId !== session.organization.id || session.actor.sessionId !== auth.sessionId
    || responsibility.id !== IdSchema.parse(routeId) || responsibility.organizationId !== session.organization.id || responsibility.environment !== 'development'
    || !session.actor.siteIds.includes(responsibility.siteId) || !session.actor.actionSiteIds.includes(responsibility.siteId)) throw ended();
  return freezeCustody(BootstrapSchema.parse({ environment: 'development', apiBase: base, userId: auth.userId,
    externalOrganizationId: auth.orgId, sessionId: auth.sessionId, organizationId: session.organization.id, actorId: session.actor.actorId,
    organizationEpoch: session.organization.authorityEpoch, roles: [...session.actor.roles].sort(), siteIds: [...session.actor.siteIds].sort(),
    actionSiteIds: [...session.actor.actionSiteIds].sort(), responsibilityId: responsibility.id, responsibilityVersion: responsibility.version, siteId: responsibility.siteId }));
}
export const custodyRecoveryBootstrapKey = (value: CustodyRecoveryBootstrap) => JSON.stringify(BootstrapSchema.parse(value));
export type CustodyRecoveryObservation = Readonly<{ bootstrap: CustodyRecoveryBootstrap; context: CustodyApiRecoveryContext;
  scope: CustodyScope; receivedAt: number; receivedMonotonic: number }>;
export function qualifyCustodyRecoveryContext(input: unknown, bootstrapInput: CustodyRecoveryBootstrap, receivedAt: number,
  receivedMonotonic: number): CustodyRecoveryObservation {
  const bootstrap = BootstrapSchema.parse(bootstrapInput), parsed = CustodyApiRecoveryContextSchema.safeParse(input);
  if (!parsed.success) throw unconfirmed();
  const context = parsed.data, owner = context.owner;
  if (context.organizationId !== bootstrap.organizationId || context.externalOrganizationId !== bootstrap.externalOrganizationId
    || context.responsibilityId !== bootstrap.responsibilityId || context.environment !== bootstrap.environment || owner.actorId !== bootstrap.actorId
    || owner.subject !== bootstrap.userId || owner.sessionId !== bootstrap.sessionId) throw ended();
  if (![receivedAt, receivedMonotonic].every(value => Number.isFinite(value) && value >= 0)
    || Date.parse(context.observedAt) > receivedAt || Date.parse(context.expiresAt) <= receivedAt) throw expired();
  const scope = CustodyScopeSchema.parse({ environment: context.environment, apiBase: bootstrap.apiBase, userId: bootstrap.userId,
    externalOrganizationId: context.externalOrganizationId, organizationId: context.organizationId, responsibilityId: context.responsibilityId, owner });
  return freezeCustody({ bootstrap, context, scope, receivedAt, receivedMonotonic });
}
/** A local display lifetime; every actual recovery read still checks authority on the server. */
export function createCustodyRecoveryClock(observation: CustodyRecoveryObservation,
  wallTime: () => number = Date.now, monotonic: () => number = () => performance.now()) {
  let highest = observation.receivedAt, lastMonotonic = observation.receivedMonotonic;
  return () => {
    const wall = wallTime(), mono = monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < 0 || mono < lastMonotonic) throw expired();
    lastMonotonic = mono; highest = Math.max(highest, wall, observation.receivedAt + mono - observation.receivedMonotonic);
    return highest;
  };
}
export type CustodyRecoveryContextAdapters = {
  currentBootstrap: () => CustodyRecoveryBootstrap | null;
  getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  wallTime?: () => number;
  monotonic?: () => number;
};
function interruption<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ended());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(ended()); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const contextErrors: Record<string, 'scope' | 'unavailable' | 'expired'> = { AUTH_REQUIRED: 'scope', FORBIDDEN: 'scope',
  CUSTODY_ACCESS_DENIED: 'scope', CUSTODY_SCOPE_CHANGED: 'scope', SETUP_REQUIRED: 'unavailable', IDENTITY_UNAVAILABLE: 'unavailable',
  UNSAFE_DATABASE_ROLE: 'unavailable', CUSTODY_EXPIRED: 'expired' };
export async function readCustodyRecoveryContext(bootstrapInput: CustodyRecoveryBootstrap, adapters: CustodyRecoveryContextAdapters,
  departure: AbortSignal): Promise<CustodyRecoveryObservation> {
  const bootstrap = freezeCustody(BootstrapSchema.parse(structuredClone(bootstrapInput)));
  const current = adapters.currentBootstrap, getToken = adapters.getToken, fetcher = adapters.fetch;
  const wall = adapters.wallTime ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const controller = new AbortController(), deadline = {}, abort = () => controller.abort(), signal = controller.signal;
  const same = () => { try { return !departure.aborted && getApiBase() === bootstrap.apiBase && custodySame(current(), bootstrap); } catch { return false; } };
  const guard = () => { if (!same() || signal.aborted) throw ended(); };
  if (departure.aborted) throw ended();
  departure.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(deadline), 10_000);
  let receivedResponse: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    guard(); const token = await interruption(getToken({ organizationId: bootstrap.externalOrganizationId, skipCache: true }), signal); guard();
    if (!token || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw ended();
    const url = `${bootstrap.apiBase}/v1/responsibilities/${encodeURIComponent(bootstrap.responsibilityId)}/custody-setups/recovery-context`;
    const response = await interruption(fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }).then(value => {
        if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw ended(); } return value;
      }), signal); receivedResponse = response; guard();
    // This endpoint emits this exact policy. Accept no extension/value aliases.
    if (response.redirected || (response.url && response.url !== url) || response.status < 200 || (response.status >= 300 && response.status < 400)
      || !/^private\s*,\s*no-store$/i.test(response.headers.get('cache-control')?.trim() ?? '')
      || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '')) throw unconfirmed();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) throw unconfirmed();
    reader = response.body?.getReader(); if (!reader) throw unconfirmed();
    let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
    for (;;) { guard(); const chunk = await interruption(reader.read(), signal); guard(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 8192) throw unconfirmed(); text += decoder.decode(chunk.value, { stream: true }); }
    text += decoder.decode(); const value = parseCustodyResponseJson(text); guard();
    if (!response.ok) {
      const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'object'
        && value.error !== null && 'code' in value.error ? value.error.code : null;
      const kind = typeof code === 'string' ? contextErrors[code] : undefined;
      if (kind === 'scope') throw ended(); if (kind === 'expired') throw expired();
      if (kind === 'unavailable') throw new CustodyClientError('unavailable', 'Custody recovery is not configured or is temporarily unavailable. Saved references remain stored.');
      throw unconfirmed();
    }
    const observation = qualifyCustodyRecoveryContext(value, bootstrap, wall(), monotonic()); guard(); return observation;
  } catch (error) {
    void (reader ? reader.cancel() : receivedResponse?.body?.cancel())?.catch(() => {});
    if (!same()) throw ended();
    if (signal.aborted && signal.reason === deadline) throw unconfirmed();
    throw error instanceof CustodyClientError ? error : unconfirmed();
  } finally { clearTimeout(timer); departure.removeEventListener('abort', abort); controller.abort(); reader?.releaseLock(); }
}
