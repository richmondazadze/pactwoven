import { z } from 'zod';
import { createClerkProviderAuthorityReaders, providerAuthorityMaximumMilliseconds,
  type ProviderAuthorityFetch, type ProviderAuthorityReaders, type ProviderAuthorityReason } from './provider-authority.js';

const ProviderId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
// Only the database's prepared delegation identity may populate this context.
// This observer does not issue grants or accept an issuing-session fallback.
export const DelegatedProviderContextSchema = z.strictObject({
  subject: ProviderId, externalOrganizationId: ProviderId, externalMembershipId: ProviderId,
  requiredRole: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/).nullable(),
});
export type DelegatedProviderContext = z.infer<typeof DelegatedProviderContextSchema>;
export type DelegatedProviderVerdict = {
  state: 'allowed' | 'denied' | 'unavailable'; reason: ProviderAuthorityReason;
  observationStartedAt: string; observationCompletedAt: string;
};
const User = z.object({ id: ProviderId, banned: z.boolean(), locked: z.boolean(), deprovisioned: z.boolean() });
const Membership = z.object({ id: ProviderId, role: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
  organization: z.object({ id: ProviderId }), public_user_data: z.object({ user_id: ProviderId }) });
const MembershipPage = z.object({ data: z.array(Membership).max(2), total_count: z.number().int().nonnegative() });
const maximumInstant = Date.parse('9999-12-31T23:59:59.999Z');
const validClock = (time: number) => Number.isSafeInteger(time) && time >= 0 && time <= maximumInstant;

function failure(error: unknown): { missing: true } | { reason: ProviderAuthorityReason } {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 404) return { missing: true };
  if (status === 401 || status === 403) return { reason: 'provider_auth' };
  if (status === 429) return { reason: 'rate_limited' };
  if (typeof status === 'number') return { reason: 'provider_unavailable' };
  const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
  return { reason: reason === 'malformed_response' || reason === 'provider_unavailable' ? reason : 'network' };
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('Observation interrupted.'));
    const done = () => signal.removeEventListener('abort', abort);
    pending.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Current provider identity for an explicitly consented grant. Local grant,
 * member, site, nonce, epoch and publication freshness remain DB responsibilities. */
export function createDelegatedProviderAuthorityObserver(
  readers: Pick<ProviderAuthorityReaders, 'user' | 'membership'>,
  dependencies: { now?: () => number } = {},
) {
  const now = dependencies.now ?? Date.now;
  return async (input: DelegatedProviderContext, options: { deadlineAt: number; signal?: AbortSignal }): Promise<DelegatedProviderVerdict> => {
    const started = now();
    if (!validClock(started)) throw Error('Authority observation clock is unavailable.');
    const startedAt = new Date(started).toISOString();
    const parent = options.signal;
    let deadline: number | undefined;
    const verdict = (state: DelegatedProviderVerdict['state'], reason: ProviderAuthorityReason): DelegatedProviderVerdict => {
      const finished = now();
      if (!validClock(finished) || finished < started) return { state: 'unavailable', reason: 'clock_invalid',
        observationStartedAt: startedAt, observationCompletedAt: startedAt };
      if (state === 'allowed' && (parent?.aborted || deadline === undefined || finished >= deadline)) {
        state = 'unavailable'; reason = parent?.aborted ? 'cancelled' : 'deadline_exceeded';
      }
      return { state, reason, observationStartedAt: startedAt, observationCompletedAt: new Date(finished).toISOString() };
    };
    const parsed = DelegatedProviderContextSchema.safeParse(input);
    if (!parsed.success) return verdict('unavailable', 'invalid_context');
    const context = parsed.data;
    if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 1) return verdict('unavailable', 'invalid_deadline');
    deadline = Math.min(options.deadlineAt, started + providerAuthorityMaximumMilliseconds);
    if (parent?.aborted) return verdict('unavailable', 'cancelled');
    if (started >= deadline) return verdict('unavailable', 'deadline_exceeded');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parent?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline - started);
    try {
      const observations = await Promise.allSettled([
        abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return readers.user(context.subject, controller.signal); }), controller.signal),
        abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return readers.membership(context.externalOrganizationId, context.subject, controller.signal); }), controller.signal),
      ]);
      if (parent?.aborted) return verdict('unavailable', 'cancelled');
      if (timedOut || now() >= deadline) return verdict('unavailable', 'deadline_exceeded');
      const failures = observations.map(result => result.status === 'rejected' ? failure(result.reason) : null);
      const unavailable = failures.find(value => value && 'reason' in value);
      if (unavailable && 'reason' in unavailable) return verdict('unavailable', unavailable.reason);
      if (failures[0] && 'missing' in failures[0]) return verdict('denied', 'user_missing');
      if (failures[1] && 'missing' in failures[1]) return verdict('denied', 'organization_missing');
      const [userResult, memberResult] = observations;
      if (userResult?.status !== 'fulfilled' || memberResult?.status !== 'fulfilled') return verdict('unavailable', 'malformed_response');
      const user = User.safeParse(userResult.value), memberships = MembershipPage.safeParse(memberResult.value);
      if (!user.success || !memberships.success || user.data.id !== context.subject) return verdict('unavailable', 'malformed_response');
      if (user.data.banned) return verdict('denied', 'user_banned');
      if (user.data.locked) return verdict('denied', 'user_locked');
      if (user.data.deprovisioned) return verdict('denied', 'user_deprovisioned');
      const { data, total_count: count } = memberships.data;
      if (count === 0 && data.length === 0) return verdict('denied', 'membership_removed');
      if (count !== 1 || data.length !== 1) return verdict('unavailable', 'malformed_response');
      const member = data[0]!;
      if (member.organization.id !== context.externalOrganizationId || member.public_user_data.user_id !== context.subject) return verdict('unavailable', 'malformed_response');
      if (member.id !== context.externalMembershipId) return verdict('denied', 'membership_replaced');
      if (context.requiredRole !== null && member.role !== context.requiredRole) return verdict('denied', 'required_role_removed');
      return verdict('allowed', 'current');
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); controller.abort(); }
  };
}

export function createClerkDelegatedProviderAuthorityObserver(config: { secretKey: string }, dependencies: {
  fetch?: ProviderAuthorityFetch; now?: () => number;
} = {}) {
  return createDelegatedProviderAuthorityObserver(createClerkProviderAuthorityReaders(config, dependencies), dependencies);
}
