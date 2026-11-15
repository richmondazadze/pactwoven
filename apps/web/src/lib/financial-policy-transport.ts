import { z } from 'zod';
import { HashSchema, FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES } from '@pactwoven/contracts';
import { getApiBase } from './config';
import { FinancialPolicyClientError, FinancialPolicyReadTargetSchema, FinancialPolicyIndexQuerySchema, FinancialPolicyReferenceSchema,
  financialParse, financialSame, freezeFinancial, qualifyFinancialRead, qualifyFinancialIndex, qualifyFinancialRecovery,
  type FinancialPolicyReadTarget, type FinancialPolicyIndexQuery, type FinancialPolicyReference } from './financial-policy-contract';
import { createFinancialPolicyClock, financialPolicyLocalScope, qualifyFinancialContext,
  type FinancialPolicyBootstrap, type FinancialPolicyLifetime, type FinancialPolicyPermission,
  type FinancialPolicyReadAction } from './financial-policy-context';
import { assertFinancialPolicyReference, type FinancialPolicyMemory, type FinancialPolicyStorage } from './financial-policy-recovery';

export const FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS = 10_000;
const unconfirmed = () => new FinancialPolicyClientError('unconfirmed');
// The wire maximum is 2 MiB, 50 records, 100 sites, and fewer than 128 keys in
// any object. 100k values allow the complete page with every site's public refs.
export function parseFinancialPolicyJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES) throw unconfirmed();
  let at = 0, tokens = 0;
  const whitespace = () => { while (at < text.length && /[\u0020\t\r\n]/.test(text[at]!)) at++; };
  function string(): string {
    const start = at; if (text[at++] !== '"') throw unconfirmed(); let escaped = false;
    while (at < text.length) { const c = text[at++]!; if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; } if (c === '"') return JSON.parse(text.slice(start, at)) as string; }
    throw unconfirmed();
  }
  function value(depth: number): void {
    if (depth > 24 || ++tokens > 100_000) throw unconfirmed(); whitespace(); const c = text[at];
    if (c === '{') {
      at++; whitespace(); const keys = new Set<string>(); if (text[at] === '}') { at++; return; }
      for (;;) { whitespace(); const key = string();
        if (keys.has(key) || keys.size >= 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw unconfirmed();
        keys.add(key); whitespace(); if (text[at++] !== ':') throw unconfirmed(); value(depth + 1); whitespace();
        if (text[at] === '}') { at++; return; } if (text[at++] !== ',') throw unconfirmed(); }
    }
    if (c === '[') {
      at++; whitespace(); let length = 0; if (text[at] === ']') { at++; return; }
      for (;;) { if (++length > 100) throw unconfirmed(); value(depth + 1); whitespace();
        if (text[at] === ']') { at++; return; } if (text[at++] !== ',') throw unconfirmed(); }
    }
    if (c === '"') { string(); return; }
    for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, at)) { at += literal.length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (!number || !Number.isFinite(Number(number[0]))) throw unconfirmed(); at += number[0].length;
  }
  try { value(0); whitespace(); if (at !== text.length) throw unconfirmed(); const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unconfirmed(); return parsed;
  } catch { throw unconfirmed(); }
}
function noStore(value: string | null) {
  if (!value || value.length > 8192) return false;
  const directive = /[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]*=[ \t]*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"))?[ \t]*(?:,|$)/y;
  let at = 0, found = false;
  while (at < value.length) { directive.lastIndex = at; const m = directive.exec(value); if (!m) return false;
    if (m[1]!.toLowerCase() === 'no-store') { if (m[2] !== undefined || m[3] !== undefined) return false; found = true; }
    at = directive.lastIndex;
  } return found;
}
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new FinancialPolicyClientError('scope')); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new FinancialPolicyClientError('scope')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function boundedJson(response: Response, signal: AbortSignal, guard: () => void) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '') ||
    !noStore(response.headers.get('cache-control'))) throw unconfirmed();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES)) throw unconfirmed();
  const reader = response.body?.getReader(); if (!reader) throw unconfirmed();
  let size = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) { guard(); const chunk = await interrupted(reader.read(), signal); guard(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES) throw unconfirmed();
      text += decoder.decode(chunk.value, { stream: true }); }
    text += decoder.decode(); return parseFinancialPolicyJson(text);
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export const FinancialPolicyContextQuerySchema = z.strictObject({ assetKey: HashSchema.nullable() });
export type FinancialPolicyContextQuery = z.infer<typeof FinancialPolicyContextQuerySchema>;
export type FinancialPolicyTransportAdapters = {
  lifetime: FinancialPolicyLifetime; memory: FinancialPolicyMemory; storage: () => FinancialPolicyStorage | null;
  currentBootstrap: () => FinancialPolicyBootstrap | null;
  getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  wall?: () => number; monotonic?: () => number;
};
/** Explicit one-shot GETs only. Construction, focus and reconnect do no I/O. */
export function createFinancialPolicyTransport(adapters: FinancialPolicyTransportAdapters) {
  const { lifetime, memory, storage, currentBootstrap, getToken, fetch: fetcher } = adapters;
  const wall = adapters.wall ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const owner = lifetime.replaceAdapters(); lifetime.onInvalidate(() => memory.clear());
  let disposed = false;
  function same(bootstrap: FinancialPolicyBootstrap) {
    try { return !disposed && getApiBase() === bootstrap.apiBase && financialSame(currentBootstrap(), bootstrap) &&
      adapters.getToken === getToken && adapters.fetch === fetcher && adapters.currentBootstrap === currentBootstrap; } catch { return false; }
  }
  async function run<T>(permission: FinancialPolicyPermission, action: FinancialPolicyReadAction, target: unknown,
    path: string, qualify: (value: unknown, bootstrap: FinancialPolicyBootstrap, at: number, mono: number) => Promise<T>,
    before?: () => void, after?: (value: T, guard: () => void) => Promise<void>) {
    lifetime.assertAdapters(owner);
    const start = wall(), mono = monotonic(), now = createFinancialPolicyClock(start, mono, wall, monotonic);
    const bootstrap = lifetime.bootstrap(), ticket = lifetime.start(permission, action, target), signal = ticket.controller.signal;
    const deadline = {}, timer = setTimeout(() => ticket.controller.abort(deadline), FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS);
    let receivedResponse: Response | undefined;
    let responseDeadline = Infinity;
    const guard = () => {
      lifetime.assertAdapters(owner);
      if (!same(bootstrap)) { if (lifetime.owns(ticket)) lifetime.invalidate(); throw new FinancialPolicyClientError('scope'); }
      lifetime.assert(ticket, bootstrap);
      if (now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) { ticket.controller.abort(deadline); throw unconfirmed(); }
      if (now() >= responseDeadline) throw new FinancialPolicyClientError('expired');
    };
    try {
      guard(); before?.(); guard();
      const token = await interrupted(getToken({ organizationId: bootstrap.externalOrganizationId, skipCache: true }), signal); guard();
      if (!token || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
      const url = bootstrap.apiBase + path;
      const response = await interrupted(fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }).then(value => {
          if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw new FinancialPolicyClientError('scope'); } return value;
        }), signal);
      receivedResponse = response; guard();
      // Denial is latched synchronously before body parsing or any caller callback.
      if (response.status === 401 || response.status === 403) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
      if (response.redirected || response.url && response.url !== url || response.status < 200 || response.status >= 300 && response.status < 400) throw unconfirmed();
      const value = await boundedJson(response, signal, guard); guard();
      if (!response.ok) {
        const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(value), code = error.success ? error.data.error.code : '';
        if (['AUTH_REQUIRED', 'FORBIDDEN', 'FINANCIAL_POLICY_ACCESS_DENIED', 'FINANCIAL_POLICY_SCOPE_CHANGED'].includes(code)) {
          lifetime.deny(); throw new FinancialPolicyClientError('scope');
        }
        if (['IDENTITY_UNAVAILABLE', 'SETUP_REQUIRED', 'FINANCIAL_POLICY_UNAVAILABLE', 'UNSAFE_DATABASE_ROLE'].includes(code)) throw new FinancialPolicyClientError('unavailable');
        if (code === 'NOT_FOUND') throw new FinancialPolicyClientError('not-found');
        throw unconfirmed();
      }
      const at = now(), receivedMonotonic = monotonic();
      const result = await interrupted(qualify(value, bootstrap, at, receivedMonotonic), signal); guard();
      if (action === 'context') lifetime.accept(ticket, result as Awaited<ReturnType<typeof qualifyFinancialContext>>);
      else {
        responseDeadline = Date.parse((result as { observation: { expiresAt: string } }).observation.expiresAt);
        guard();
      }
      if (after) { await interrupted(after(result, guard), signal); guard(); }
      return result;
    } catch (error) {
      void receivedResponse?.body?.cancel().catch(() => {});
      if (!same(bootstrap)) { if (lifetime.owns(ticket)) lifetime.invalidate(); throw new FinancialPolicyClientError('scope'); }
      if (signal.aborted && signal.reason === deadline) throw unconfirmed();
      if (error instanceof FinancialPolicyClientError && lifetime.owns(ticket)) {
        if (error.code === 'scope' && !signal.aborted) lifetime.deny();
        else if (error.code === 'scope' || error.code === 'expired') lifetime.invalidate();
      }
      throw error instanceof FinancialPolicyClientError && error.code !== 'input' ? error : unconfirmed();
    } finally { clearTimeout(timer); lifetime.finish(ticket); }
  }
  function observationTime(value: { observation: { observedAt: string; expiresAt: string } }, at: number) {
    if (Date.parse(value.observation.observedAt) > at || Date.parse(value.observation.expiresAt) <= at) throw new FinancialPolicyClientError('expired');
  }
  function matchingResponsibility(id: string | null) {
    if (id !== lifetime.bootstrap().responsibilityId) throw new FinancialPolicyClientError('scope');
  }
  return {
    async context(queryInput: FinancialPolicyContextQuery, permission: FinancialPolicyPermission) {
      const query = freezeFinancial(financialParse(FinancialPolicyContextQuerySchema, queryInput)), b = lifetime.bootstrap();
      if (b.responsibilityId !== null && query.assetKey !== null) throw new FinancialPolicyClientError('input');
      const root = b.responsibilityId === null ? '/v1/financial-governance/context' : `/v1/responsibilities/${b.responsibilityId}/financial-policies/context`;
      return run(permission, 'context', query, root + (query.assetKey ? `?assetKey=${query.assetKey}` : ''), async (value, bootstrap, at, mono) => {
        const qualified = await qualifyFinancialContext(value, bootstrap, at, mono);
        if (query.assetKey !== null && qualified.context.asset !== null && qualified.context.asset.pin.key !== query.assetKey) throw unconfirmed();
        return qualified;
      });
    },
    async read(targetInput: FinancialPolicyReadTarget, permission: FinancialPolicyPermission) {
      const target = freezeFinancial(financialParse(FinancialPolicyReadTargetSchema, targetInput)); matchingResponsibility(target.responsibilityId);
      const observed = lifetime.observation();
      const root = target.responsibilityId === null ? '/v1/financial-governance' : `/v1/responsibilities/${target.responsibilityId}`;
      const family = target.kind === 'document' ? target.responsibilityId === null ? '/documents' : '/financial-policy-documents' : target.kind === 'draft' ? '/financial-policies' : '';
      return run(permission, 'read', target, `${root}${family}/${target.id}/versions/${target.version}`, async (value, _b, at) => {
        const result = await qualifyFinancialRead(value, observed.context.scope, target); observationTime(result, at); return result;
      });
    },
    async index(queryInput: FinancialPolicyIndexQuery, permission: FinancialPolicyPermission) {
      const query = freezeFinancial(financialParse(FinancialPolicyIndexQuerySchema, queryInput)); matchingResponsibility(query.responsibilityId);
      const observed = lifetime.observation(), root = query.responsibilityId === null ? '/v1/financial-governance' : `/v1/responsibilities/${query.responsibilityId}/financial-policies`;
      const params = new URLSearchParams({ limit: String(query.limit) }); if (query.afterId !== null) params.set('afterId', query.afterId);
      return run(permission, 'index', query, `${root}?${params}`, async (value, _b, at) => {
        const result = await qualifyFinancialIndex(value, observed.context.scope, query); observationTime(result, at); return result;
      });
    },
    async lookup(referenceInput: FinancialPolicyReference, permission: FinancialPolicyPermission) {
      const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, referenceInput)), observed = lifetime.observation();
      if (!financialSame(reference.scope, financialPolicyLocalScope(observed.bootstrap))) throw new FinancialPolicyClientError('scope');
      const l = reference.locator, root = l.responsibilityId === null ? '/v1/financial-governance/operations' : `/v1/responsibilities/${l.responsibilityId}/financial-policy-operations`;
      const params = new URLSearchParams({ kind: l.kind, targetId: l.targetId, requestHash: l.publicRequestHash });
      return run(permission, 'lookup', reference, `${root}/${encodeURIComponent(l.key)}?${params}`, async (value, _b, at) => {
        const result = await qualifyFinancialRecovery(value, observed.context.scope, reference, memory.original(reference) ?? undefined);
        observationTime(result, at); return result;
      }, () => { assertFinancialPolicyReference(storage(), reference); }, async (result, guard) => {
        guard(); if (result.receipt) { await memory.record(reference, result.receipt, guard); guard(); }
      });
    },
    dispose() { disposed = true; try { lifetime.assertAdapters(owner); lifetime.invalidate(); } catch { /* Replaced adapters own the route now. */ } },
  };
}
