import { NativeDelegatedAuthorityRequestSchema, NativeDelegatedAuthorityResponseSchema, NativeDelegatedAuthorityPrepareSchema,
  NativeDelegatedAuthorityVerdictSchema, NativeDelegatedStoredAuthorityResultSchema, NativeProviderIssuerSchema,
  type NativeDelegatedAuthorityRepository, type NativeAuthorityResult } from '@pactwoven/contracts';
import type { DelegatedProviderContext, DelegatedProviderVerdict } from './delegated-provider-authority.js';

export type NativeDelegatedAuthorityResources = {
  repository: NativeDelegatedAuthorityRepository;
  issuer: string;
  observe: (context: DelegatedProviderContext, options: { deadlineAt: number; signal: AbortSignal }) => Promise<DelegatedProviderVerdict>;
};
function normalize(input: unknown): NativeAuthorityResult {
  const value = NativeDelegatedStoredAuthorityResultSchema.parse(input);
  return value.state === 'stale' ? { state: 'stale', observedAt: null, validUntil: null } : value;
}

const bodyMaximum = 8192;
const unavailable: NativeAuthorityResult = { state: 'unavailable', observedAt: null, validUntil: null, retryAfterMilliseconds: 1000 };
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
class BodyError extends Error { constructor(readonly status: number) { super('Invalid authority request.'); } }
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('Authority observation interrupted.'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      request.headers.has('content-encoding')) throw new BodyError(400);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > bodyMaximum)) throw new BodyError(413);
  if (!request.body) throw new BodyError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (let count = 0; count < 1024; count++) {
      signal.throwIfAborted();
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new BodyError(400); }
      }
      size += chunk.value.byteLength;
      if (size > bodyMaximum) throw new BodyError(413);
      chunks.push(chunk.value);
    }
    throw new BodyError(413);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Workload identity authenticates the transport. Only prepare -> fresh provider
 * observation -> database finish may create task authority; the request contains
 * no provider identity, credential, nonce, endpoint or caller-selected verdict. */
export function createNativeDelegatedAuthorityHandler(dependencies: {
  verify: (request: Request) => Promise<boolean>;
  resources: () => Promise<NativeDelegatedAuthorityResources>;
  deadlineAt: number;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/internal/native-delegated-authority' || url.search) return new Response(null, { status: 404, headers });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers });
    const start = now(), deadlineAt = Math.min(dependencies.deadlineAt - 100, start + 15_000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deadlineAt) || deadlineAt <= start || request.signal.aborted) {
      return new Response(null, { status: 503, headers });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, deadlineAt - start);
    let lastClock = start;
    const check = () => {
      controller.signal.throwIfAborted(); const current = now();
      if (!Number.isSafeInteger(current) || current < lastClock || current >= deadlineAt) throw Error('Authority clock or deadline is invalid.');
      lastClock = current;
    };
    try {
      if (!await bounded(dependencies.verify(request), controller.signal)) return new Response(null, { status: 401, headers });
      check();
      const input = NativeDelegatedAuthorityRequestSchema.safeParse(await readBody(request, controller.signal));
      if (!input.success) return new Response(null, { status: 400, headers });
      check();
      const resources = await bounded(dependencies.resources(), controller.signal);
      check();
      const issuer = NativeProviderIssuerSchema.parse(resources.issuer);
      // Starting before DB prepare is conservative even when the two hosts'
      // clocks differ. Database preparation controls the actual grant lifetime.
      const prepareStartedAt = now();
      const prepared = NativeDelegatedAuthorityPrepareSchema.parse(await bounded(resources.repository.prepare(input.data.target, issuer), controller.signal));
      check();
      let result: NativeAuthorityResult;
      if (prepared.kind === 'pending') result = { ...unavailable, retryAfterMilliseconds: prepared.retryAfterMilliseconds };
      else if (prepared.kind === 'settled') result = normalize(prepared.result);
      else {
        if (prepared.providerIssuer !== issuer || JSON.stringify(prepared.target) !== JSON.stringify(input.data.target)) {
          throw Error('Authority preparation changed scope.');
        }
        const observationDeadline = Math.min(deadlineAt - 500, prepareStartedAt +
          Date.parse(prepared.deadlineAt) - Date.parse(prepared.preparedAt) - 100);
        if (now() >= observationDeadline) result = unavailable;
        else {
          const verdict = NativeDelegatedAuthorityVerdictSchema.parse(await bounded(resources.observe(prepared.context,
            { deadlineAt: observationDeadline, signal: controller.signal }), controller.signal));
          check();
          if (now() >= observationDeadline) throw Error('Observation finished after its deadline.');
          result = normalize(await bounded(resources.repository.finish(prepared.nonce, verdict), controller.signal));
          check();
        }
      }
      const response = NativeDelegatedAuthorityResponseSchema.parse({ schemaVersion: 1, target: input.data.target, result });
      return Response.json(response, { headers });
    } catch (error) {
      return new Response(null, { status: error instanceof BodyError ? error.status : 503, headers });
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort); controller.abort();
    }
  };
}
