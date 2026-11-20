import { getVercelOidcToken } from '@vercel/functions/oidc';
import { NativeDelegatedAuthorityResponseSchema, NativeDelegatedAuthorityTargetSchema,
  type NativeAuthorityResult, type NativeDelegatedAuthorityTarget } from '@pactwoven/contracts';

export const nativeDelegatedAuthorityMaximumMilliseconds = 10_000;
export const nativeDelegatedAuthorityMaximumResponseBytes = 8 * 1024;
type Observation = { result: NativeAuthorityResult; usableUntil: number | null };
export type NativeDelegatedAuthorityClient = (selector: NativeDelegatedAuthorityTarget, options: { deadlineAt: number; signal?: AbortSignal }) => Promise<Observation>;
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
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > nativeDelegatedAuthorityMaximumResponseBytes))) {
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
      if (++reads > nativeDelegatedAuthorityMaximumResponseBytes + 8) throw interrupted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > nativeDelegatedAuthorityMaximumResponseBytes) throw interrupted();
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
export function createNativeDelegatedAuthorityClient(apiOrigin: string, dependencies: ClientDependencies = {}): NativeDelegatedAuthorityClient {
  const target = new URL('/internal/native-delegated-authority', origin(apiOrigin));
  const token = dependencies.token ?? (() => getVercelOidcToken());
  const request = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now;
  return async (input, options) => {
    const start = now(), parsed = NativeDelegatedAuthorityTargetSchema.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(start) || !Number.isSafeInteger(options.deadlineAt) ||
        start < 0 || options.deadlineAt <= start || options.signal?.aborted) return unavailable();
    const selector = parsed.data;
    const deadline = Math.min(options.deadlineAt, start + nativeDelegatedAuthorityMaximumMilliseconds);
    const controller = new AbortController(), cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, deadline - start);
    try {
      const credential = await abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return token(); }), controller.signal);
      if (controller.signal.aborted || now() >= deadline || credential.length > 16_384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) return unavailable();
      const response = await abortable(request(target, { method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: controller.signal, headers: { Authorization: `Bearer ${credential}`, 'x-vercel-trusted-oidc-idp-token': credential,
          'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ schemaVersion: 1, target: selector }) }), controller.signal);
      const result = NativeDelegatedAuthorityResponseSchema.parse(await responseJson(response, controller.signal));
      const end = now();
      if (controller.signal.aborted || !Number.isSafeInteger(end) || end < start || end >= deadline ||
          JSON.stringify(result.target) !== JSON.stringify(selector)) return unavailable();
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

