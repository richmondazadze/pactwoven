import { z } from 'zod';

const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const providerRole = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);
/** Private DB-prepared identity only. Parsing is not authentication; callers
 * must derive this binding from the stored task, never the HTTP/model body. */
export const ProviderAuthorityContextSchema = z.strictObject({
  sessionId: providerId, subject: providerId, externalOrganizationId: providerId,
  externalMembershipId: providerId, requiredRole: providerRole.nullable(),
});
export type ProviderAuthorityContext = z.infer<typeof ProviderAuthorityContextSchema>;
export type ProviderAuthorityReason = 'current' | 'session_missing' | 'session_inactive' | 'session_expired'
  | 'user_missing' | 'user_banned' | 'user_locked' | 'user_deprovisioned'
  | 'organization_missing' | 'membership_removed' | 'membership_replaced' | 'required_role_removed'
  | 'invalid_context' | 'invalid_deadline' | 'cancelled' | 'deadline_exceeded' | 'clock_invalid'
  | 'provider_auth' | 'rate_limited' | 'provider_unavailable' | 'network' | 'malformed_response';
export type ProviderAuthorityVerdict = {
  state: 'allowed' | 'denied' | 'unavailable'; reason: ProviderAuthorityReason;
  observationStartedAt: string; observationCompletedAt: string; providerExpiresAt: string | null;
};
/** Readers return the official REST JSON shapes, not SDK resource instances.
 * They must make fresh reads and pass the supplied signal to the transport. */
export type ProviderAuthorityReaders = {
  session: (sessionId: string, signal: AbortSignal) => Promise<unknown>;
  user: (subject: string, signal: AbortSignal) => Promise<unknown>;
  membership: (organizationId: string, subject: string, signal: AbortSignal) => Promise<unknown>;
};
export const providerAuthorityMaximumMilliseconds = 8_000;
export const providerAuthorityMaximumResponseBytes = 64 * 1024;
// Shared authority timestamps use four-digit ISO years. JavaScript Date also
// accepts expanded years, which would produce a verdict the DB contract rejects.
const maximumInstantMilliseconds = Date.parse('9999-12-31T23:59:59.999Z');
const instantMilliseconds = z.number().int().nonnegative().max(maximumInstantMilliseconds);
// Extra provider fields are discarded, never copied to the verdict.
const SessionSchema = z.object({ id: providerId, user_id: providerId, status: z.string().min(1).max(64),
  actor: z.null(), created_at: instantMilliseconds, expire_at: instantMilliseconds, abandon_at: instantMilliseconds });
const UserSchema = z.object({ id: providerId, banned: z.boolean(), locked: z.boolean(), deprovisioned: z.boolean() });
const MembershipSchema = z.object({ id: providerId, role: providerRole,
  organization: z.object({ id: providerId }), public_user_data: z.object({ user_id: providerId }) });
const MembershipPageSchema = z.object({ data: z.array(MembershipSchema).max(2), total_count: z.number().int().nonnegative() });

class ProviderReadError extends Error {
  constructor(readonly reason: 'network' | 'malformed_response' | 'provider_unavailable', readonly status?: number) {
    super('The provider observation is unavailable.');
  }
}
function readFailure(error: unknown): { unavailable?: ProviderAuthorityReason; missing?: true } {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403) return { unavailable: 'provider_auth' };
  if (status === 429) return { unavailable: 'rate_limited' };
  if (status === 404) return { missing: true };
  if (typeof status === 'number') return { unavailable: 'provider_unavailable' };
  return { unavailable: error instanceof ProviderReadError ? error.reason : 'network' };
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderReadError('provider_unavailable'));
    const done = () => signal.removeEventListener('abort', abort);
    operation.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A verdict is an observation, never a reusable grant. The DB finish/CAS must
 * bind it to the original nonce/task and enforce its own freshness and denial barrier. */
export function createProviderAuthorityObserver(readers: ProviderAuthorityReaders, dependencies: { now?: () => number } = {}) {
  const now = dependencies.now ?? Date.now;
  return async (input: ProviderAuthorityContext, options: { deadlineAt: number; signal?: AbortSignal }): Promise<ProviderAuthorityVerdict> => {
    const start = now();
    if (!Number.isSafeInteger(start) || start < 0 || start > maximumInstantMilliseconds) throw new Error('Authority observation clock is unavailable.');
    const startedAt = new Date(start).toISOString();
    const parentSignal = options.signal;
    let effectiveDeadline: number | undefined;
    const verdict = (state: ProviderAuthorityVerdict['state'], reason: ProviderAuthorityReason, expiry: number | null = null): ProviderAuthorityVerdict => {
      const end = now();
      if (!Number.isSafeInteger(end) || end < start || end > maximumInstantMilliseconds) {
        return { state: 'unavailable', reason: 'clock_invalid', observationStartedAt: startedAt, observationCompletedAt: startedAt, providerExpiresAt: null };
      }
      if (state === 'allowed' && (parentSignal?.aborted || effectiveDeadline === undefined || end >= effectiveDeadline)) {
        state = 'unavailable'; reason = parentSignal?.aborted ? 'cancelled' : 'deadline_exceeded'; expiry = null;
      } else if (state === 'allowed' && expiry !== null && end >= expiry) { state = 'denied'; reason = 'session_expired'; }
      return { state, reason, observationStartedAt: startedAt, observationCompletedAt: new Date(end).toISOString(),
        providerExpiresAt: expiry === null ? null : new Date(expiry).toISOString() };
    };
    const parsed = ProviderAuthorityContextSchema.safeParse(input);
    if (!parsed.success) return verdict('unavailable', 'invalid_context');
    // Zod creates the snapshot before readers/transport await. Required role and
    // identity cannot be rebound by a caller mutating the original object.
    const context = parsed.data;
    if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 1) return verdict('unavailable', 'invalid_deadline');
    const deadlineAt = Math.min(options.deadlineAt, start + providerAuthorityMaximumMilliseconds);
    effectiveDeadline = deadlineAt;
    if (parentSignal?.aborted) return verdict('unavailable', 'cancelled');
    if (deadlineAt <= start) return verdict('unavailable', 'deadline_exceeded');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineAt - start);
    try {
      const results = await Promise.allSettled([
        abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return readers.session(context.sessionId, controller.signal); }), controller.signal),
        abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return readers.user(context.subject, controller.signal); }), controller.signal),
        abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return readers.membership(context.externalOrganizationId, context.subject, controller.signal); }), controller.signal),
      ]);
      if (parentSignal?.aborted) return verdict('unavailable', 'cancelled');
      if (timedOut || now() >= deadlineAt) return verdict('unavailable', 'deadline_exceeded');
      const failures = results.map(result => result.status === 'rejected' ? readFailure(result.reason) : null);
      // A partial/failed observation never becomes an allow or an invented
      // account revocation. Definitive absence applies only after other reads finish.
      const unavailable = failures.find(failure => failure?.unavailable)?.unavailable;
      if (unavailable) return verdict('unavailable', unavailable);
      const [sessionResult, userResult, membershipResult] = results;
      if (failures[0]?.missing) return verdict('denied', 'session_missing');
      if (failures[1]?.missing) return verdict('denied', 'user_missing');
      if (failures[2]?.missing) return verdict('denied', 'organization_missing');
      if (sessionResult?.status !== 'fulfilled' || userResult?.status !== 'fulfilled' || membershipResult?.status !== 'fulfilled') return verdict('unavailable', 'malformed_response');
      const session = SessionSchema.safeParse(sessionResult.value), user = UserSchema.safeParse(userResult.value), memberships = MembershipPageSchema.safeParse(membershipResult.value);
      if (!session.success || !user.success || !memberships.success) return verdict('unavailable', 'malformed_response');
      if (session.data.id !== context.sessionId || session.data.user_id !== context.subject || user.data.id !== context.subject ||
          session.data.created_at > start || session.data.expire_at <= session.data.created_at || session.data.abandon_at <= session.data.created_at) return verdict('unavailable', 'malformed_response');
      const expiry = Math.min(session.data.expire_at, session.data.abandon_at);
      const activeStatuses = ['active', 'ended', 'revoked', 'expired', 'removed', 'replaced', 'abandoned', 'pending'];
      if (!activeStatuses.includes(session.data.status)) return verdict('unavailable', 'malformed_response');
      if (session.data.status !== 'active') return verdict('denied', 'session_inactive', expiry);
      if (expiry <= now()) return verdict('denied', 'session_expired', expiry);
      if (user.data.banned) return verdict('denied', 'user_banned', expiry);
      if (user.data.locked) return verdict('denied', 'user_locked', expiry);
      if (user.data.deprovisioned) return verdict('denied', 'user_deprovisioned', expiry);
      const { data, total_count: count } = memberships.data;
      if (count === 0 && data.length === 0) return verdict('denied', 'membership_removed', expiry);
      if (count !== 1 || data.length !== 1) return verdict('unavailable', 'malformed_response');
      const member = data[0]!;
      if (member.organization.id !== context.externalOrganizationId || member.public_user_data.user_id !== context.subject) return verdict('unavailable', 'malformed_response');
      if (member.id !== context.externalMembershipId) return verdict('denied', 'membership_replaced', expiry);
      if (context.requiredRole !== null && member.role !== context.requiredRole) return verdict('denied', 'required_role_removed', expiry);
      // No browser JWT, browser activity or lastActiveOrganizationId is used.
      return verdict('allowed', 'current', expiry);
    } finally {
      clearTimeout(timeout); parentSignal?.removeEventListener('abort', cancel); controller.abort();
    }
  };
}

export type ProviderAuthorityFetch = (url: URL, init: RequestInit) => Promise<Response>;
/** @clerk/backend 3.29.0 exposes no request signal/fetch injection in its public
 * BAPI options. Use its fixed official REST endpoints and version, without a
 * process-wide fetch patch or uncancellable SDK retries. No writes are exposed. */
export function createClerkProviderAuthorityReaders(config: { secretKey: string }, dependencies: {
  fetch?: ProviderAuthorityFetch;
} = {}): ProviderAuthorityReaders {
  const secretKey = config.secretKey;
  if (!/^sk_(?:test|live)_[A-Za-z0-9_-]{8,4096}$/.test(secretKey)) throw new Error('Clerk authority verification is not configured.');
  const request = dependencies.fetch ?? fetch;
  const read = async (path: string, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await abortable(request(new URL(`https://api.clerk.com/v1/${path}`), {
        method: 'GET', signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json', 'Clerk-API-Version': '2026-05-12' },
      }), signal);
    } catch { throw new ProviderReadError('network'); }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderReadError('provider_unavailable', response.status);
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const declared = response.headers.get('content-length');
    if (mime !== 'application/json' || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > providerAuthorityMaximumResponseBytes)) || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new ProviderReadError('malformed_response');
    }
    const body = response.body.getReader();
    const abort = () => { void body.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await abortable(body.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > providerAuthorityMaximumResponseBytes) throw new ProviderReadError('malformed_response');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new ProviderReadError('malformed_response'); }
    } finally {
      signal.removeEventListener('abort', abort); void body.cancel().catch(() => {}); body.releaseLock();
    }
  };
  return {
    session: (session, signal) => read(`sessions/${encodeURIComponent(session)}`, signal),
    user: (subject, signal) => read(`users/${encodeURIComponent(subject)}`, signal),
    membership: (organization, subject, signal) => read(`organizations/${encodeURIComponent(organization)}/memberships?${new URLSearchParams({ user_id: subject, limit: '2' })}`, signal),
  };
}

export function createClerkProviderAuthorityObserver(config: { secretKey: string }, dependencies: {
  fetch?: ProviderAuthorityFetch; now?: () => number;
} = {}) {
  return createProviderAuthorityObserver(createClerkProviderAuthorityReaders(config, dependencies), dependencies);
}
