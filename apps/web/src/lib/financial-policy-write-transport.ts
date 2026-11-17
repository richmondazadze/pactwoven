import { FinancialPolicyHttpMutationResponseSchema, FinancialPolicyHttpRequestSchema, FinancialPolicyHttpScopeSchema,
  FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES, type FinancialPolicyHttpRequest } from '@pactwoven/contracts';
import { getApiBase } from './config';
import { FinancialPolicyClientError, financialParse, financialSame, freezeFinancial, matchFinancialScope,
  qualifyFinancialReceipt, verifyFinancialPolicyAttempt, type FinancialPolicyAttempt,
  type FinancialPolicyQualifiedReceipt } from './financial-policy-contract';
import { createFinancialPolicyClock, financialPolicyLocalScope, type FinancialPolicyBootstrap,
  type FinancialPolicyLifetime, type FinancialPolicyObservation } from './financial-policy-context';
import { FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS, parseFinancialPolicyJson } from './financial-policy-transport';

export type FinancialPolicyWriteRequest = Extract<FinancialPolicyHttpRequest, { kind: 'save_document' | 'save_draft' }>;
export function parseFinancialPolicyWriteRequest(input: unknown): FinancialPolicyWriteRequest {
  const request = freezeFinancial(financialParse(FinancialPolicyHttpRequestSchema, input));
  if (request.kind !== 'save_document' && request.kind !== 'save_draft' || request.kind === 'save_draft' &&
    [request.input.draft.asset, request.input.draft.account, request.input.draft.governance, request.input.draft.trust].some(v => v !== null))
    throw new FinancialPolicyClientError('input');
  const maximum = request.kind === 'save_document' ? 256 * 1024 : 32 * 1024;
  if (new TextEncoder().encode(JSON.stringify(request.input)).byteLength > maximum) throw new FinancialPolicyClientError('input');
  return request;
}

/** A local coordinator lease, not a server authorization or a read permission. */
export type FinancialPolicyWritePermit = Readonly<{
  bootstrap: FinancialPolicyBootstrap; observation: FinancialPolicyObservation; signal: AbortSignal;
  assertCurrent: () => void; markDispatched: () => void;
  settle: (receipt: FinancialPolicyQualifiedReceipt, guard: () => void) => Promise<void>;
}>;
export type FinancialPolicyWriteTransportAdapters = {
  lifetime: FinancialPolicyLifetime; currentBootstrap: () => FinancialPolicyBootstrap | null;
  getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  claim?: ((lease: object, attempt: FinancialPolicyAttempt) => FinancialPolicyWritePermit) | null;
  wall?: () => number; monotonic?: () => number;
};
const unknown = () => new FinancialPolicyClientError('unconfirmed');
/** Only the failed pre-dispatch stage is retained, never the provider exception. */
export class FinancialPolicyWriteTokenError extends FinancialPolicyClientError {
  readonly reason = 'token-unavailable' as const;
  constructor() { super('unconfirmed'); }
}
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(unknown()); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(unknown()); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(unknown()); });
  });
}
function noStore(value: string | null): boolean {
  if (!value || value.length > 8192) return false;
  const directive = /[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]*=[ \t]*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"))?[ \t]*(?:,|$)/y;
  let at = 0, found = false;
  while (at < value.length) {
    directive.lastIndex = at; const match = directive.exec(value); if (!match) return false;
    if (match[1]!.toLowerCase() === 'no-store') { if (match[2] !== undefined || match[3] !== undefined) return false; found = true; }
    at = directive.lastIndex;
  }
  return found;
}
async function boundedJson(response: Response, signal: AbortSignal, guard: () => void): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '') ||
    !noStore(response.headers.get('cache-control'))) throw unknown();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES)) throw unknown();
  const reader = response.body?.getReader(); if (!reader) throw unknown();
  const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, text = '';
  try {
    for (;;) {
      guard(); const chunk = await interrupted(reader.read(), signal); guard(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES) throw unknown();
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (length !== null && Number(length) !== size) throw unknown();
    text += decoder.decode(); return parseFinancialPolicyJson(text);
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** No construction I/O, default capability, automatic retry or read-lifetime takeover. */
export function createFinancialPolicyWriteTransport(adapters: FinancialPolicyWriteTransportAdapters) {
  const { lifetime, currentBootstrap, getToken, fetch: fetcher, claim } = adapters;
  const wall = adapters.wall ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const suppliedWall = adapters.wall, suppliedMonotonic = adapters.monotonic;
  let disposed = false, active: AbortController | null = null;
  const unlisten = lifetime.onInvalidate(() => active?.abort());
  const sameAdapters = () => !disposed && adapters.lifetime === lifetime && adapters.currentBootstrap === currentBootstrap &&
    adapters.getToken === getToken && adapters.fetch === fetcher && adapters.claim === claim &&
    adapters.wall === suppliedWall && adapters.monotonic === suppliedMonotonic;
  return {
    async submit(input: FinancialPolicyAttempt, lease: object): Promise<FinancialPolicyQualifiedReceipt> {
      if (!sameAdapters() || active) throw new FinancialPolicyClientError('scope');
      if (!claim) throw new FinancialPolicyClientError('unavailable');
      // All caller-owned material is detached before the first asynchronous digest.
      const pending = structuredClone(input), request = parseFinancialPolicyWriteRequest(pending.request);
      const permit = claim(lease, freezeFinancial(pending));
      const bootstrap = freezeFinancial(financialParse(
        // The observation was qualified by the accepted lifetime, not this transport.
        FinancialPolicyHttpScopeSchema, permit.observation.context.scope));
      const capturedBootstrap = permit.bootstrap, observation = permit.observation;
      const assertCurrent = permit.assertCurrent, markDispatched = permit.markDispatched, settle = permit.settle;
      if (!financialSame(pending.reference.scope, financialPolicyLocalScope(capturedBootstrap)) ||
        request.responsibilityId !== capturedBootstrap.responsibilityId || request.input.organizationEpoch !== bootstrap.organizationEpoch)
        throw new FinancialPolicyClientError('scope');
      const start = wall(), mono = monotonic(), now = createFinancialPolicyClock(start, mono, wall, monotonic);
      const controller = new AbortController(), signal = controller.signal; active = controller;
      const abort = () => controller.abort(); permit.signal.addEventListener('abort', abort, { once: true });
      if (permit.signal.aborted) abort();
      const timer = setTimeout(abort, FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS);
      let response: Response | undefined, responseDeadline = Infinity, dispatched = false;
      function guard() {
        if (!sameAdapters() || active !== controller || !financialSame(currentBootstrap(), capturedBootstrap) ||
          getApiBase() !== capturedBootstrap.apiBase || !financialSame(lifetime.bootstrap(), capturedBootstrap) ||
          lifetime.observation() !== observation || permit.assertCurrent !== assertCurrent || permit.markDispatched !== markDispatched ||
          permit.settle !== settle) throw new FinancialPolicyClientError('scope');
        if (signal.aborted || now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw unknown();
        if (now() >= responseDeadline) throw new FinancialPolicyClientError('expired');
        assertCurrent();
      }
      try {
        guard(); const attempt = await interrupted(verifyFinancialPolicyAttempt(pending), signal); guard();
        if (!financialSame(attempt.request, request)) throw new FinancialPolicyClientError('input');
        let token: string | null;
        try { token = await interrupted(getToken({ organizationId: capturedBootstrap.externalOrganizationId, skipCache: true }), signal); }
        catch { throw new FinancialPolicyWriteTokenError(); }
        guard();
        if (!token || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        const url = capturedBootstrap.apiBase + request.route;
        const init: RequestInit = { method: 'POST', body: JSON.stringify(request.input), cache: 'no-store', credentials: 'omit',
          redirect: 'error', referrerPolicy: 'no-referrer', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': request.key } };
        guard();
        // A synchronous throw from fetch is already beyond the dispatch boundary.
        markDispatched();
        dispatched = true;
        const received = await interrupted(Promise.resolve(fetcher(url, init)).then(value => {
          if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw unknown(); } return value;
        }), signal);
        response = received;
        guard();
        if (received.status === 401 || received.status === 403) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        if (received.redirected || received.url && received.url !== url || received.status < 200 || received.status >= 300 && received.status < 400)
          throw unknown();
        const value = await boundedJson(received, signal, guard); guard();
        if (!received.ok) {
          const code = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' &&
            'code' in value.error ? value.error.code : null;
          if (['AUTH_REQUIRED', 'FORBIDDEN', 'FINANCIAL_POLICY_ACCESS_DENIED', 'FINANCIAL_POLICY_SCOPE_CHANGED'].includes(String(code))) {
            lifetime.deny(); throw new FinancialPolicyClientError('scope');
          }
          throw unknown();
        }
        const result = freezeFinancial(financialParse(FinancialPolicyHttpMutationResponseSchema, value));
        try { matchFinancialScope(result.scope, bootstrap); }
        catch { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        const receivedAt = now(); responseDeadline = Date.parse(result.observation.expiresAt);
        if (Date.parse(result.observation.observedAt) > receivedAt) throw new FinancialPolicyClientError('expired');
        guard();
        const receipt = await interrupted(qualifyFinancialReceipt(result.receipt, attempt.reference, attempt), signal); guard();
        await interrupted(settle(receipt, guard), signal); guard(); return receipt;
      } catch (error) {
        void response?.body?.cancel().catch(() => {});
        throw error instanceof FinancialPolicyClientError && (!dispatched || ['scope', 'expired', 'unconfirmed'].includes(error.code)) ? error : unknown();
      } finally {
        clearTimeout(timer); permit.signal.removeEventListener('abort', abort); controller.abort();
        if (active === controller) active = null;
      }
    },
    dispose() { disposed = true; active?.abort(); unlisten(); },
  };
}
export type FinancialPolicyWriteTransport = ReturnType<typeof createFinancialPolicyWriteTransport>;
