import { getVercelOidcToken } from '@vercel/functions/oidc';
import { NativeAuthorityResponseSchema, NativeDispatchClaimSchema, NativeDispatchMessageSchema,
  type NativeAuthorityResult, type NativeDispatchMessage, type NativeDispatchWorkerRepository,
  type NativeTaskClaim, type NativeTaskWorkerRepository } from '@pactwoven/contracts';

export const nativeAuthorityMaximumMilliseconds = 10_000;
export const nativeAuthorityMaximumResponseBytes = 8 * 1024;
type Observation = { result: NativeAuthorityResult; usableUntil: number | null };
export type NativeAuthorityClient = (dispatch: NativeDispatchMessage, options: { deadlineAt: number; signal?: AbortSignal }) => Promise<Observation>;
type ClientDependencies = { token?: () => Promise<string>; fetch?: typeof fetch; now?: () => number };
const unavailable = (): Observation => ({ result: { state: 'unavailable', observedAt: null, validUntil: null, retryAfterMilliseconds: 1000 }, usableUntil: null });
const interrupted = () => Error('Current task authority has not been confirmed.');
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(interrupted());
    const done = () => signal.removeEventListener('abort', abort);
    operation.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
function origin(value: string): string {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(value)) throw interrupted();
  return value;
}
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const declared = response.headers.get('content-length');
  if (response.status !== 200 || mime !== 'application/json' || !response.body ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > nativeAuthorityMaximumResponseBytes))) {
    void response.body?.cancel().catch(() => undefined); throw interrupted();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0, reads = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      // Also bound pathological streams of zero-byte chunks.
      if (++reads > nativeAuthorityMaximumResponseBytes + 8) throw interrupted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > nativeAuthorityMaximumResponseBytes) throw interrupted();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

/** Calls only the configured API project. The response is a DB observation,
 * never a substitute for the repository's claim/write authority gates. */
export function createNativeAuthorityClient(apiOrigin: string, dependencies: ClientDependencies = {}): NativeAuthorityClient {
  const target = new URL('/internal/native-authority', origin(apiOrigin));
  const token = dependencies.token ?? (() => getVercelOidcToken());
  const request = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now;
  return async (input, options) => {
    const start = now(), parsed = NativeDispatchMessageSchema.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(start) || !Number.isSafeInteger(options.deadlineAt) ||
        start < 0 || options.deadlineAt <= start || options.signal?.aborted) return unavailable();
    const dispatch = parsed.data;
    const deadline = Math.min(options.deadlineAt, start + nativeAuthorityMaximumMilliseconds);
    const controller = new AbortController(), cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, deadline - start);
    try {
      const credential = await abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return token(); }), controller.signal);
      if (controller.signal.aborted || now() >= deadline || credential.length > 16_384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) return unavailable();
      const response = await abortable(request(target, { method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: controller.signal, headers: { Authorization: `Bearer ${credential}`, 'x-vercel-trusted-oidc-idp-token': credential,
          'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ schemaVersion: 1, dispatch }) }), controller.signal);
      const result = NativeAuthorityResponseSchema.parse(await responseJson(response, controller.signal));
      const end = now();
      if (controller.signal.aborted || !Number.isSafeInteger(end) || end < start || end >= deadline ||
          JSON.stringify(result.dispatch) !== JSON.stringify(dispatch)) return unavailable();
      if (result.result.state !== 'allowed') return { result: result.result, usableUntil: null };
      const providerUntil = Date.parse(result.result.validUntil!);
      const duration = providerUntil - Date.parse(result.result.observedAt!);
      // Preparation is fresh and follows this request. Conservatively start the
      // DB interval before token acquisition; never add transport time or rely
      // on an executor clock behind PostgreSQL to extend the grant.
      const usableUntil = Math.min(providerUntil, start + duration, start + 20_000);
      if (usableUntil <= end) return unavailable();
      return { result: result.result, usableUntil };
    } catch { return unavailable(); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); controller.abort(); }
  };
}

/** One delivery owns one scope and cancellation lifetime. Every successful
 * renewal refreshes through the API; no observer verdict is written here. */
export function createAuthorityBoundRepositories(dependencies: {
  repository: NativeTaskWorkerRepository; dispatchRepository: NativeDispatchWorkerRepository;
  authority: NativeAuthorityClient; deadlineAt: number; now?: () => number;
}) {
  const now = dependencies.now ?? Date.now, controller = new AbortController();
  let target: NativeDispatchMessage | undefined;
  let affinity: Pick<NativeTaskClaim, 'environment' | 'organizationId' | 'actorId' | 'leaseToken'> & { taskId: string } | undefined;
  let usableUntil = 0, expiry: ReturnType<typeof setTimeout> | undefined;
  let refreshPending: Promise<NativeAuthorityResult> | undefined;
  const stop = () => { clearTimeout(expiry); controller.abort(); };
  const current = () => !controller.signal.aborted && usableUntil > now() && dependencies.deadlineAt > now();
  const assertCurrent = () => { if (!current()) { stop(); throw interrupted(); } };
  const matches = (input: NativeTaskClaim) => affinity !== undefined && input.environment === affinity.environment &&
    input.organizationId === affinity.organizationId && input.task.id === affinity.taskId &&
    input.actorId === affinity.actorId && input.leaseToken === affinity.leaseToken;
  const refresh = (): Promise<NativeAuthorityResult> => {
    if (refreshPending) return refreshPending;
    if (!target || controller.signal.aborted || now() >= dependencies.deadlineAt) { stop(); return Promise.resolve(unavailable().result); }
    const dispatch = target;
    refreshPending = (async () => {
      let observation: Observation;
      try { observation = await dependencies.authority(dispatch, { deadlineAt: dependencies.deadlineAt, signal: controller.signal }); }
      catch { observation = unavailable(); }
      if (controller.signal.aborted) return unavailable().result;
      if (observation.result.state !== 'allowed' || observation.usableUntil === null || observation.usableUntil <= now()) {
        stop(); return observation.result.state === 'allowed' ? unavailable().result : observation.result;
      }
      usableUntil = Math.min(observation.usableUntil, dependencies.deadlineAt);
      clearTimeout(expiry); expiry = setTimeout(stop, Math.max(0, usableUntil - now()));
      return observation.result;
    })().finally(() => { refreshPending = undefined; });
    return refreshPending;
  };
  const repository: NativeTaskWorkerRepository = {
    // Hosted work must enter through a generation-bound target, never a scan.
    claim: async () => null,
    renew: async (input, leaseMilliseconds) => {
      const selected = structuredClone(input);
      if (!matches(selected) || !current()) { stop(); return false; }
      if ((await refresh()).state !== 'allowed' || !current()) return false;
      try {
        const held = await dependencies.repository.renew(selected, leaseMilliseconds);
        if (!held || !current()) { stop(); return false; }
        return true;
      } catch { stop(); return false; }
    },
    progress: async (input, update) => {
      const selected = structuredClone(input);
      if (!matches(selected) || !current()) { stop(); return false; }
      const saved = await dependencies.repository.progress(selected, update);
      if (!saved || !current()) { stop(); return false; }
      return true;
    },
    release: async input => {
      const selected = structuredClone(input);
      if (!matches(selected) || !current()) { stop(); return; }
      await dependencies.repository.release(selected);
    },
  };
  const dispatchRepository: NativeDispatchWorkerRepository = {
    claimTarget: async (input, workerId, leaseMilliseconds) => {
      const parsed = NativeDispatchMessageSchema.safeParse(input);
      if (!parsed.success || target || controller.signal.aborted) { stop(); return { kind: 'stale' }; }
      target = parsed.data;
      const result = await refresh();
      if (result.state !== 'allowed') return result.state === 'denied' ? { kind: 'revoked' }
        : result.state === 'stale' ? { kind: 'stale' } : { kind: 'not_ready', retryAfterMilliseconds: result.retryAfterMilliseconds ?? 1000 };
      if (!current()) { stop(); return { kind: 'not_ready', retryAfterMilliseconds: 1000 }; }
      const acquired = await dependencies.dispatchRepository.claimTarget(target, workerId, leaseMilliseconds);
      if (acquired.kind !== 'claimed') { stop(); return acquired; }
      const checked = NativeDispatchClaimSchema.safeParse({ claim: acquired.claim, dispatch: acquired.dispatch });
      if (!checked.success || JSON.stringify(checked.data.dispatch) !== JSON.stringify(target) || !current()) {
        stop(); return { kind: 'not_ready', retryAfterMilliseconds: 1000 };
      }
      const owned = checked.data.claim;
      affinity = Object.freeze({ environment: owned.environment, organizationId: owned.organizationId, actorId: owned.actorId,
        taskId: owned.task.id, leaseToken: owned.leaseToken });
      return { kind: 'claimed', ...checked.data };
    },
    yieldClaim: async (work, progress, delayMilliseconds) => {
      const selected = structuredClone(work);
      if (!matches(selected.claim) || JSON.stringify(selected.dispatch) !== JSON.stringify(target) || !current()) { stop(); return false; }
      const saved = await dependencies.dispatchRepository.yieldClaim(selected, progress, delayMilliseconds);
      if (!saved || !current()) { stop(); return false; }
      return true;
    },
  };
  return { repository, dispatchRepository, signal: controller.signal, assertCurrent, close: stop };
}
