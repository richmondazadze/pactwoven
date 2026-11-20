import { getApiBase } from './config';
import type { RecoveryStorage } from './bootstrap-recovery';
import { CustodyClientError, CustodyScopeSchema, CustodyLocatorSchema, CustodyReadTargetSchema, custodyParse, custodySame, custodyScopeKey, custodyVisibleIdentity, freezeCustody, qualifyCustodyMutation, qualifyCustodyRecovery, qualifyCustodyRead, verifyCustodyAttempt, type CustodyAttempt, type CustodyLocator, type CustodyScope, type CustodyVisibleIdentity } from './custody-setup-contract';
import { assertCustodyReference, listCustodyReferences, storeCustodyReference, type CustodyMemory } from './custody-setup-recovery';

export type CustodyAction = 'send' | 'retry' | 'lookup' | 'read';
export type CustodyPermission = Readonly<{ action: CustodyAction; identity: CustodyVisibleIdentity }>;
// Consumers explicitly invalidate on observation/scope replacement, hide and
// unmount. activate never replays an action or revives an old permission.
export function createCustodyLifetime(initial: CustodyScope) {
  let scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(initial))), generation = 0, visible = true, alive = true, active: { controller: AbortController; generation: number } | null = null;
  const permissions = new WeakMap<object, { generation: number; used: boolean }>();
  const ended = () => new CustodyClientError('scope', 'The custody setup observation ended. Its original outcome remains separate.');
  function invalidate() { generation++; active?.controller.abort(); active = null; }
  // Observation ownership classifies an abort; it never grants dispatch. assert
  // separately rejects every aborted ticket, including a transport deadline.
  const ownsObservation = (ticket: { controller: AbortController; generation: number }, expected: CustodyScope) => alive && visible && active === ticket && generation === ticket.generation && custodySame(scope, expected);
  return {
    authorize(action: CustodyAction, identity: CustodyVisibleIdentity): CustodyPermission { if (!alive || !visible || active || identity.scopeKey !== custodyScopeKey(scope) || !['send', 'retry', 'lookup', 'read'].includes(action)) throw ended(); const permission = freezeCustody({ action, identity: structuredClone(identity) }); permissions.set(permission, { generation, used: false }); return permission; },
    start(permission: CustodyPermission, action: CustodyAction, identity: CustodyVisibleIdentity) { const issued = permissions.get(permission); if (!alive || !visible || active || !issued || issued.used || issued.generation !== generation || permission.action !== action || !custodySame(permission.identity, identity)) throw ended(); issued.used = true; const ticket = { controller: new AbortController(), generation }; active = ticket; return ticket; },
    assert(ticket: { controller: AbortController; generation: number }, expected: CustodyScope) { if (!ownsObservation(ticket, expected) || ticket.controller.signal.aborted) throw ended(); },
    ownsObservation,
    finish(ticket: { controller: AbortController; generation: number }) { if (active === ticket) active = null; },
    invalidate, hide() { visible = false; invalidate(); }, activate(next: CustodyScope) { if (!alive) throw ended(); invalidate(); scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(next))); visible = true; }, close() { alive = false; visible = false; invalidate(); },
  };
}
export type CustodyLifetime = ReturnType<typeof createCustodyLifetime>;
export const CUSTODY_RESPONSE_MAX_BYTES = 65536;
function unconfirmed() { return new CustodyClientError('unconfirmed', 'The original custody setup result is unconfirmed. Check its exact original reference.'); }
// Strict JSON syntax walk preserves duplicate-key detection before JSON.parse.
export function parseCustodyResponseJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > CUSTODY_RESPONSE_MAX_BYTES) throw unconfirmed(); let at = 0, count = 0;
  const whitespace = () => { while (/[\u0020\t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
  function string(): string { const start = at; if (text[at++] !== '"') throw unconfirmed(); let escaped = false; while (at < text.length) { const c = text[at++]!; if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === '"') { try { return JSON.parse(text.slice(start, at)); } catch { throw unconfirmed(); } } } throw unconfirmed(); }
  function value(depth: number): void { if (depth > 24 || ++count > 4096) throw unconfirmed(); whitespace(); const c = text[at];
    if (c === '{') { at++; whitespace(); const keys = new Set<string>(); if (text[at] === '}') { at++; return; } for (;;) { whitespace(); const key = string(); if (keys.has(key) || keys.size >= 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') throw unconfirmed(); keys.add(key); whitespace(); if (text[at++] !== ':') throw unconfirmed(); value(depth + 1); whitespace(); if (text[at] === '}') { at++; return; } if (text[at++] !== ',') throw unconfirmed(); } }
    if (c === '[') { at++; whitespace(); let length = 0; if (text[at] === ']') { at++; return; } for (;;) { if (++length > 128) throw unconfirmed(); value(depth + 1); whitespace(); if (text[at] === ']') { at++; return; } if (text[at++] !== ',') throw unconfirmed(); } }
    if (c === '"') { string(); return; } for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, at)) { at += literal.length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at)); if (!number || !Number.isFinite(Number(number[0]))) throw unconfirmed(); at += number[0].length;
  }
  try { value(0); whitespace(); if (at !== text.length) throw unconfirmed(); const result: unknown = JSON.parse(text); if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed(); return result; } catch { throw unconfirmed(); }
}
// Parse directive syntax so quoted values and extension names cannot imply no-store.
function hasNoStoreDirective(value: string | null): boolean {
  if (!value || value.length > 8192) return false;
  const directive = /[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:[ \t]*=[ \t]*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)|"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*)"))?[ \t]*(?:,|$)/y;
  let at = 0, found = false;
  while (at < value.length) {
    directive.lastIndex = at; const match = directive.exec(value);
    if (!match) return false;
    if (match[1]!.toLowerCase() === 'no-store') { if (match[2] !== undefined || match[3] !== undefined) return false; found = true; }
    at = directive.lastIndex;
  }
  return found;
}
async function boundedJson(response: Response, signal: AbortSignal, guard: () => void) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '') || !hasNoStoreDirective(response.headers.get('cache-control'))) throw unconfirmed();
  const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > CUSTODY_RESPONSE_MAX_BYTES)) throw unconfirmed();
  const reader = response.body?.getReader(); if (!reader) throw unconfirmed(); let size = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try { for (;;) { guard(); const chunk = await interrupted(reader.read(), signal); guard(); if (chunk.done) break; size += chunk.value.byteLength; if (size > CUSTODY_RESPONSE_MAX_BYTES) throw unconfirmed(); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); return parseCustodyResponseJson(text); }
  catch (error) { void reader.cancel().catch(() => {}); throw error instanceof CustodyClientError ? error : unconfirmed(); } finally { reader.releaseLock(); }
}
function interrupted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> { if (signal.aborted) return Promise.reject(new CustodyClientError('scope', 'The custody observation ended. Preserve the original reference.')); return new Promise((resolve, reject) => { const abort = () => { cleanup(); reject(new CustodyClientError('scope', 'The custody observation ended. Preserve the original reference.')); }; const cleanup = () => signal.removeEventListener('abort', abort); signal.addEventListener('abort', abort, { once: true }); pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); }); }); }
const safeErrors: Record<string, ['verification' | 'unavailable' | 'scope' | 'expired' | 'not-found' | 'unconfirmed', string]> = {
  STEP_UP_REQUIRED: ['verification', 'Verify both factors again for this exact setup action.'], AUTH_REQUIRED: ['scope', 'Sign in again to check the original setup.'], CUSTODY_ACCESS_DENIED: ['scope', 'Current owner and site access are required.'], FORBIDDEN: ['scope', 'Current owner and site access are required.'], CUSTODY_SCOPE_CHANGED: ['scope', 'The exact custody setup scope changed.'], CUSTODY_EXPIRED: ['expired', 'The setup verification expired. Preserve the original reference.'], SETUP_REQUIRED: ['unavailable', 'Custody setup is not configured.'], IDENTITY_UNAVAILABLE: ['unavailable', 'Identity verification is temporarily unavailable.'], NOT_FOUND: ['not-found', 'No original result was found at this check. This does not cancel the original.'],
};
export function createCustodyTransport(deps: { lifetime: CustodyLifetime; memory: CustodyMemory; storage: () => RecoveryStorage | null; currentScope: () => CustodyScope | null; getToken: (options: { organizationId: string; skipCache: true }) => Promise<string | null>; fetch: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number; now?: () => number }) {
  const lifetime = deps.lifetime, memory = deps.memory, storage = deps.storage.bind(deps), currentScope = deps.currentScope.bind(deps), getToken = deps.getToken.bind(deps), fetcher = deps.fetch.bind(deps), now = deps.now?.bind(deps) ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 10000; if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new CustodyClientError('input', 'A bounded custody request deadline is required.');
  async function run<T>(permission: CustodyPermission, action: CustodyAction, scope: CustodyScope, identity: CustodyVisibleIdentity, work: (call: (url: string, body?: unknown, beforeDispatch?: () => void, key?: string) => Promise<unknown>, guard: () => void) => Promise<T>) {
    const ticket = lifetime.start(permission, action, identity), signal = ticket.controller.signal; const guard = () => { lifetime.assert(ticket, scope); if (getApiBase() !== scope.apiBase || !custodySame(currentScope(), scope)) throw new CustodyClientError('scope', 'The current authenticated custody scope changed.'); };
    const deadline = {}; // Private identity distinguishes this timer from a scope abort.
    const timer = setTimeout(() => ticket.controller.abort(deadline), timeoutMs);
    const call = async (path: string, body?: unknown, beforeDispatch?: () => void, key?: string) => {
      guard(); const token = await interrupted(getToken({ organizationId: scope.externalOrganizationId, skipCache: true }), signal); guard(); if (!token || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new CustodyClientError('scope', 'Sign in again to check the original setup.');
      const url = scope.apiBase + path, headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` }; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (key) headers['Idempotency-Key'] = key;
      const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      guard(); beforeDispatch?.(); guard(); const response = await interrupted(fetcher(url, init), signal); guard(); if (response.redirected || (response.url && response.url !== url) || response.status < 200 || response.status >= 300 && response.status < 400) throw unconfirmed(); const value = await boundedJson(response, signal, guard); guard();
      if (!response.ok) { const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'object' && value.error !== null && 'code' in value.error ? value.error.code : null; const safe = typeof code === 'string' ? safeErrors[code] : undefined; if (safe) throw new CustodyClientError(...safe); throw unconfirmed(); } return value;
    };
    try { guard(); return await work(call, guard); } catch (error) {
      if (signal.aborted && signal.reason === deadline) {
        let stillCurrent = false;
        try { stillCurrent = lifetime.ownsObservation(ticket, scope) && getApiBase() === scope.apiBase && custodySame(currentScope(), scope); } catch { /* A lost observation remains a scope interruption. */ }
        if (!stillCurrent) throw new CustodyClientError('scope', 'The current authenticated custody scope changed.');
        throw new CustodyClientError('unconfirmed', 'The custody request timed out. Preserve its original reference and check it explicitly.');
      }
      throw error instanceof CustodyClientError ? error : unconfirmed();
    } finally { clearTimeout(timer); lifetime.finish(ticket); }
  }
  return {
    async send(input: CustodyAttempt, permission: CustodyPermission) {
      const snapshot = freezeCustody(structuredClone(input)), scope = snapshot.scope, identity = custodyVisibleIdentity(scope, snapshot.locator), action = permission.action;
      if (action !== 'send' && action !== 'retry') throw new CustodyClientError('input', 'A separate exact send or retry action is required.');
      return run(permission, action, scope, identity, async (call, guard) => {
        const attempt = await verifyCustodyAttempt(snapshot); guard();
        if (action === 'retry') { const original = memory.original(attempt.locator); if (!original || !custodySame(original, attempt) || memory.recorded(attempt.locator)) throw new CustodyClientError('input', 'Only the retained exact original can be retried after separate review.'); assertCustodyReference(storage(), attempt.locator); }
        else { const inventory = listCustodyReferences(storage(), scope); if (inventory.blocked || inventory.references.some(r => (!memory.recorded(r) && (attempt.request.kind !== 'cancel' || r.kind === 'cancel')) || custodySame(r, attempt.locator))) throw new CustodyClientError('storage', 'Check unresolved custody setup originals before creating another request.'); if (now() < attempt.reviewedAt || now() - attempt.reviewedAt >= 60000 || (attempt.request.kind !== 'cancel' && now() >= Date.parse(attempt.locator.pins.expiresAt))) throw new CustodyClientError('expired', 'Refresh and review the exact setup before this action.'); await memory.retain(attempt); guard(); storeCustodyReference(storage(), attempt.locator); guard(); }
        const r = attempt.request, root = `/v1/responsibilities/${r.responsibilityId}/custody-setups`, suffix = { challenge: 'owner-challenge', confirmation: 'owner-confirmation-challenge', confirm: 'confirm-owner', cancel: 'cancel' };
        const path = r.kind === 'prepare' ? root : `${root}/${r.setupId}/${suffix[r.kind]}`;
        const value = await call(path, r.body, () => { guard(); if (action === 'send') { if (now() - attempt.reviewedAt >= 60000 || (r.kind !== 'cancel' && now() >= Date.parse(attempt.locator.pins.expiresAt))) throw new CustodyClientError('expired', 'The setup review expired while waiting.'); assertCustodyReference(storage(), attempt.locator); const inventory = listCustodyReferences(storage(), scope); if (inventory.blocked || inventory.references.some(other => !custodySame(other, attempt.locator) && !memory.recorded(other) && (r.kind !== 'cancel' || other.kind === 'cancel'))) throw new CustodyClientError('storage', 'Another unresolved original needs checking.'); } else assertCustodyReference(storage(), attempt.locator); guard(); }, r.body.key);
        const result = await qualifyCustodyMutation(value, attempt); guard(); await memory.record(attempt.locator, result.operation); guard(); return result;
      });
    },
    async lookup(locatorInput: CustodyLocator, scopeInput: CustodyScope, permission: CustodyPermission) {
      const locator = freezeCustody(custodyParse(CustodyLocatorSchema, structuredClone(locatorInput))), scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(scopeInput))), identity = custodyVisibleIdentity(scope, locator);
      return run(permission, 'lookup', scope, identity, async (call, guard) => { assertCustodyReference(storage(), locator); const value = await call(`/v1/responsibilities/${scope.responsibilityId}/custody-setups/operations/${encodeURIComponent(locator.key)}?kind=${locator.kind}`); const result = await qualifyCustodyRecovery(value, locator, scope, memory.original(locator) ?? undefined); guard(); if (result.operation) { await memory.record(locator, result.operation); guard(); } return result; });
    },
    async read(scopeInput: CustodyScope, targetInput: Parameters<typeof qualifyCustodyRead>[2], identityInput: CustodyVisibleIdentity, permission: CustodyPermission, previous?: Parameters<typeof qualifyCustodyRead>[3]) {
      const scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(scopeInput))), target = freezeCustody(custodyParse(CustodyReadTargetSchema, structuredClone(targetInput))), identity = freezeCustody(structuredClone(identityInput)), prior = previous ? freezeCustody(structuredClone(previous)) : undefined;
      return run(permission, 'read', scope, identity, async (call, guard) => { const value = await call(`/v1/responsibilities/${scope.responsibilityId}/custody-setups/${target.setupId}`); const result = await qualifyCustodyRead(value, scope, target, prior); guard(); return freezeCustody({ ...result, identity }); });
    },
  };
}
