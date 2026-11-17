import { FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES, FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES } from '@pactwoven/contracts';
import { FinancialPolicyClientError, financialSame, freezeFinancial } from './financial-policy-contract';
import { createFinancialPolicyClock, type FinancialPolicyBootstrap, type FinancialPolicyLifetime, type FinancialPolicyObservation } from './financial-policy-context';
import { FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS, parseFinancialPolicyJson } from './financial-policy-transport';
import { parseFinancialPolicyWriteRequest } from './financial-policy-write-transport';
import type { FinancialPolicyPreparationVerifier } from './financial-policy-attempt-coordinator';
import { assertQualifiedFinancialPolicyPreparation, parseFinancialPolicyPreparationSelection, qualifyFinancialPolicyPreparation,
  type FinancialPolicyPreparationSelection, type QualifiedFinancialPolicyPreparation } from './financial-policy-preparation-contract';
import { getApiBase } from './config';

export type FinancialPolicyPreparationClientAdapters = {
  lifetime: FinancialPolicyLifetime; currentBootstrap: () => FinancialPolicyBootstrap | null;
  getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  wall?: () => number; monotonic?: () => number;
};
declare const ticketBrand: unique symbol;
export type FinancialPolicyPreparationTicket = Readonly<{ [ticketBrand]: true }>;
export type FinancialPolicyPreparationSnapshot = Readonly<{
  state: 'idle' | 'checking' | 'reviewable' | 'blocked' | 'not_evaluated' | 'expired' | 'denied' | 'unavailable';
  preparation: QualifiedFinancialPolicyPreparation | null;
}>;
type Ticket = { generation: number; used: boolean; bootstrap: FinancialPolicyBootstrap;
  observation: FinancialPolicyObservation; selection: FinancialPolicyPreparationSelection };
const unavailable = () => new FinancialPolicyClientError('unavailable');
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(unavailable()); }
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener('abort', abort), abort = () => { clean(); reject(unavailable()); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
  });
}
function noStore(value: string | null) {
  if (!value || value.length > 8192) return false;
  const pattern = /[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]*=[ \t]*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"))?[ \t]*(?:,|$)/y;
  let at = 0, found = false;
  while (at < value.length) {
    pattern.lastIndex = at; const match = pattern.exec(value); if (!match) return false;
    if (match[1]!.toLowerCase() === 'no-store') { if (match[2] !== undefined || match[3] !== undefined) return false; found = true; }
    at = pattern.lastIndex;
  }
  return found;
}
async function readJson(response: Response, signal: AbortSignal, guard: () => void): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '') || !noStore(response.headers.get('cache-control')))
    throw unavailable();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES)) throw unavailable();
  const reader = response.body?.getReader(); if (!reader) throw unavailable();
  let size = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      guard(); const next = await interrupted(reader.read(), signal); guard(); if (next.done) break;
      size += next.value.byteLength; if (size > FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES) throw unavailable();
      text += decoder.decode(next.value, { stream: true });
    }
    if (length !== null && Number(length) !== size) throw unavailable();
    return parseFinancialPolicyJson(text + decoder.decode());
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Explicit metadata checks only. A stable verifier remains unavailable until this instance qualifies a response. */
export function createFinancialPolicyPreparationClient(adapters: FinancialPolicyPreparationClientAdapters) {
  const { lifetime, currentBootstrap, getToken, fetch: fetcher } = adapters;
  const suppliedWall = adapters.wall, suppliedMono = adapters.monotonic;
  const wall = suppliedWall ?? Date.now, monotonic = suppliedMono ?? (() => performance.now());
  let alive = true, generation = 0, active: AbortController | null = null;
  let value: QualifiedFinancialPolicyPreparation | null = null, valueNow: (() => number) | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let snapshot: FinancialPolicyPreparationSnapshot = Object.freeze({ state: 'idle', preparation: null });
  const serverSnapshot = snapshot, tickets = new WeakMap<object, Ticket>(), listeners = new Set<() => void>();
  function publish(state: FinancialPolicyPreparationSnapshot['state'], preparation: QualifiedFinancialPolicyPreparation | null = null) {
    snapshot = freezeFinancial({ state, preparation });
    for (const listener of listeners) { try { listener(); } catch { /* Subscribers cannot reopen an invalidated check. */ } }
  }
  function invalidate(state: FinancialPolicyPreparationSnapshot['state'] = 'idle') {
    generation++; const previous = active; active = null; value = null; valueNow = null;
    if (expiry !== null) clearTimeout(expiry); expiry = null;
    previous?.abort(); publish(state);
  }
  const unlisten = lifetime.onInvalidate(() => invalidate('unavailable'));
  function current() {
    if (!alive || adapters.lifetime !== lifetime || adapters.currentBootstrap !== currentBootstrap || adapters.getToken !== getToken ||
      adapters.fetch !== fetcher || adapters.wall !== suppliedWall || adapters.monotonic !== suppliedMono) throw new FinancialPolicyClientError('scope');
    try {
      const observation = lifetime.observation(), bootstrap = lifetime.bootstrap();
      if (!financialSame(currentBootstrap(), bootstrap) || getApiBase() !== bootstrap.apiBase) throw new FinancialPolicyClientError('scope');
      return { bootstrap, observation };
    } catch (error) { throw error instanceof FinancialPolicyClientError ? error : new FinancialPolicyClientError('scope'); }
  }
  function exact(ticket: Ticket) {
    const context = current();
    if (ticket.generation !== generation || !financialSame(ticket.bootstrap, context.bootstrap) || ticket.observation !== context.observation)
      throw new FinancialPolicyClientError('scope');
  }
  function installed() {
    const context = current();
    if (!value || !valueNow) throw unavailable();
    assertQualifiedFinancialPolicyPreparation(value);
    if (value.observation !== context.observation || !financialSame(value.observation.bootstrap, context.bootstrap)) throw new FinancialPolicyClientError('scope');
    if (valueNow() >= value.expiresAt) throw new FinancialPolicyClientError('expired');
    return value;
  }
  function safeFailure(error: unknown): FinancialPolicyClientError {
    return error instanceof FinancialPolicyClientError && ['scope', 'expired', 'unavailable'].includes(error.code) ? error : unavailable();
  }
  const verifier: FinancialPolicyPreparationVerifier = Object.freeze({
    capture(review: Parameters<FinancialPolicyPreparationVerifier['capture']>[0]) {
      try {
        const prepared = installed(), owner = generation, request = parseFinancialPolicyWriteRequest(review.request);
        if (active || prepared.response.decision.state !== 'reviewable') throw unavailable();
        if (review.observation !== prepared.observation || !financialSame(review.bootstrap, prepared.observation.bootstrap) ||
          request.responsibilityId !== prepared.response.responsibilityId || request.input.organizationEpoch !== prepared.response.scope.organizationEpoch)
          throw new FinancialPolicyClientError('scope');
        const expected = request.kind === 'save_document' ? { schemaVersion: 1, action: request.kind, targetId: request.id,
          previous: request.input.previous, purpose: request.input.purpose } : { schemaVersion: 1, action: request.kind, targetId: request.id,
          previous: request.input.previous, document: { id: request.input.draft.documents[0]!.id, version: request.input.draft.documents[0]!.version,
            recordHash: request.input.draft.documents[0]!.recordHash } };
        if (!financialSame(prepared.selection, expected)) throw new FinancialPolicyClientError('input');
        const material = prepared.response.material;
        if (request.kind === 'save_document' && (material.action !== 'save_document' || material.purpose !== request.input.purpose ||
          material.organizationEpoch !== request.input.organizationEpoch) || request.kind === 'save_draft' && (material.action !== 'save_draft' ||
          !financialSame(request.input.draft.scope, material.draftScope) || !financialSame(request.input.draft.scope, prepared.observation.context.draftScope) ||
          !material.document || !financialSame(request.input.draft.documents, [{ ...material.document.reference, purpose: 'financial_mandate' }])))
          throw new FinancialPolicyClientError('input');
        const assertCurrent = () => {
          if (generation !== owner || installed() !== prepared || active) throw new FinancialPolicyClientError('expired');
          if (request.kind === 'save_draft' && Date.parse(request.input.draft.expiresAt) <= valueNow!()) throw new FinancialPolicyClientError('expired');
        };
        const now = () => { assertCurrent(); return valueNow!(); };
        assertCurrent(); return Object.freeze({ expiresAt: prepared.expiresAt, assertCurrent, now });
      } catch (error) { throw safeFailure(error); }
    },
  });
  return {
    verifier,
    issue(input: unknown): FinancialPolicyPreparationTicket {
      const { bootstrap, observation } = current(); if (active) throw new FinancialPolicyClientError('scope');
      invalidate();
      const selection = parseFinancialPolicyPreparationSelection(input, bootstrap.responsibilityId);
      const token = Object.freeze({}) as FinancialPolicyPreparationTicket;
      tickets.set(token, { generation, used: false, bootstrap, observation, selection }); return token;
    },
    async prepare(token: FinancialPolicyPreparationTicket): Promise<QualifiedFinancialPolicyPreparation> {
      const ticket = tickets.get(token);
      if (!ticket || ticket.used || active) throw new FinancialPolicyClientError('scope');
      ticket.used = true; exact(ticket);
      const controller = new AbortController(); active = controller;
      const expired = {};
      let timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined;
      try {
        const start = wall(), now = createFinancialPolicyClock(start, monotonic(), wall, monotonic);
        let responseDeadline = Infinity;
        const arm = () => {
          if (timer !== undefined) clearTimeout(timer);
          const end = Math.min(start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS, ticket.observation.expiresAt, responseDeadline);
          timer = setTimeout(() => controller.abort(end < start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS ? expired : undefined), Math.max(0, end - now()));
        };
        arm();
        const guard = (deadline?: number) => {
          if (deadline !== undefined && deadline < responseDeadline) { responseDeadline = deadline; arm(); }
          exact(ticket);
          if (controller.signal.reason === expired || now() >= responseDeadline) throw new FinancialPolicyClientError('expired');
          if (active !== controller || controller.signal.aborted || now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw unavailable();
        };
        publish('checking'); guard();
        const body = JSON.stringify(ticket.selection);
        if (new TextEncoder().encode(body).byteLength > FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES) throw new FinancialPolicyClientError('input');
        const tokenValue = await interrupted(getToken({ organizationId: ticket.bootstrap.externalOrganizationId, skipCache: true }), controller.signal); guard();
        if (!tokenValue || !/^[A-Za-z0-9._~-]{1,8192}$/.test(tokenValue)) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        const path = ticket.bootstrap.responsibilityId === null ? '/v1/financial-governance-preparation'
          : `/v1/responsibilities/${ticket.bootstrap.responsibilityId}/financial-policy-preparation`;
        const url = ticket.bootstrap.apiBase + path;
        const received = await interrupted(Promise.resolve(fetcher(url, { method: 'POST', body, cache: 'no-store', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${tokenValue}` } }))
          .then(result => { if (controller.signal.aborted) { void result.body?.cancel().catch(() => {}); throw unavailable(); } return result; }), controller.signal);
        response = received; guard();
        if (received.status === 401 || received.status === 403) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        if (received.redirected || received.url && received.url !== url || received.status < 200 || received.status >= 300 && received.status < 400) throw unavailable();
        const raw = await readJson(received, controller.signal, guard); guard();
        if (received.status !== 200) {
          const code = raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object' && 'code' in raw.error ? raw.error.code : null;
          if (['AUTH_REQUIRED', 'FORBIDDEN', 'FINANCIAL_POLICY_ACCESS_DENIED', 'FINANCIAL_POLICY_SCOPE_CHANGED'].includes(String(code))) {
            lifetime.deny(); throw new FinancialPolicyClientError('scope');
          }
          throw unavailable();
        }
        const result = await interrupted(qualifyFinancialPolicyPreparation(raw, ticket.selection, ticket.observation, now(), monotonic(), guard), controller.signal); guard();
        const resultNow = createFinancialPolicyClock(result.receivedAt, result.receivedMonotonic, wall, monotonic);
        if (resultNow() >= result.expiresAt) throw new FinancialPolicyClientError('expired');
        // No await between the final lifetime/deadline check and installing a qualified observation.
        guard(); value = result; valueNow = resultNow; active = null;
        expiry = setTimeout(() => { if (generation === ticket.generation && value === result) invalidate('expired'); }, Math.max(0, result.expiresAt - resultNow()));
        publish(result.response.decision.state, result);
        current(); if (generation !== ticket.generation || value !== result) throw new FinancialPolicyClientError('scope');
        if (now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw unavailable();
        if (resultNow() >= result.expiresAt) throw new FinancialPolicyClientError('expired');
        return result;
      } catch (error) {
        void response?.body?.cancel().catch(() => {});
        const safe = controller.signal.reason === expired ? new FinancialPolicyClientError('expired') : safeFailure(error);
        if (ticket.generation === generation) {
          if (safe.code === 'scope') {
            try { exact(ticket); lifetime.deny(); } catch { /* A replacement scope cannot inherit an obsolete denial. */ }
          }
          if (ticket.generation === generation) invalidate(safe.code === 'scope' ? 'denied' : safe.code === 'expired' ? 'expired' : 'unavailable');
        }
        throw safe;
      } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); if (active === controller) active = null; }
    },
    getSnapshot(): FinancialPolicyPreparationSnapshot {
      try { current(); if (value) installed(); }
      catch (error) {
        const safe = safeFailure(error), next = safe.code === 'expired' ? 'expired' : safe.code === 'scope' ? 'denied' : 'unavailable';
        if (snapshot.state !== next || snapshot.preparation !== null) invalidate(next);
      }
      return snapshot;
    },
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate() { invalidate(); },
    close() { alive = false; invalidate('unavailable'); unlisten(); listeners.clear(); },
  };
}
export type FinancialPolicyPreparationClient = ReturnType<typeof createFinancialPolicyPreparationClient>;
