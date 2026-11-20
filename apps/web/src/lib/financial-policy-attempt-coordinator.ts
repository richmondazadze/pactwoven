import { canonicalJson } from '@pactwoven/contracts/canonical';
import { FinancialPolicyClientError, FinancialPolicyReferenceSchema, createFinancialPolicyAttempt, financialParse,
  financialSame, freezeFinancial, type FinancialPolicyAttempt, type FinancialPolicyReference,
  type FinancialPolicyQualifiedReceipt } from './financial-policy-contract';
import { createFinancialPolicyClock, financialPolicyLocalScope, type FinancialPolicyBootstrap,
  type FinancialPolicyLifetime, type FinancialPolicyObservation } from './financial-policy-context';
import { FINANCIAL_POLICY_REFERENCE_LIMIT, FINANCIAL_POLICY_REFERENCE_MAX_BYTES, FINANCIAL_POLICY_REFERENCE_PREFIX,
  assertFinancialPolicyReference, financialPolicyReferenceKey, storeFinancialPolicyReference,
  type FinancialPolicyMemory, type FinancialPolicyStorage } from './financial-policy-recovery';
import { createFinancialPolicyWriteTransport, parseFinancialPolicyWriteRequest, FinancialPolicyWriteTokenError, type FinancialPolicyWritePermit,
  type FinancialPolicyWriteRequest, type FinancialPolicyWriteTransportAdapters } from './financial-policy-write-transport';
import { getApiBase } from './config';
import { FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS } from './financial-policy-transport';

export const FINANCIAL_POLICY_INITIAL_SAVE_MARGIN_MS = FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS + 1_000;

/** Installed only by a separately reviewed preparation client. No wire schema or native fallback lives here. */
export type FinancialPolicyPreparationVerifier = Readonly<{
  capture: (review: Readonly<{ request: FinancialPolicyWriteRequest; bootstrap: FinancialPolicyBootstrap;
    observation: FinancialPolicyObservation }>) => Readonly<{ expiresAt: number; assertCurrent: () => void; now: () => number }>;
}>;
export type FinancialPolicyAttemptCoordinatorAdapters = Omit<FinancialPolicyWriteTransportAdapters, 'claim'> & {
  memory: FinancialPolicyMemory; storage: () => FinancialPolicyStorage | null;
  preparation?: FinancialPolicyPreparationVerifier | null;
};
declare const gestureBrand: unique symbol;
export type FinancialPolicyWriteGesture = Readonly<{ [gestureBrand]: true }>;
export class FinancialPolicyWriteAttemptError extends FinancialPolicyClientError {
  constructor(code: FinancialPolicyClientError['code'], readonly outcome: 'not-dispatched' | 'unknown',
    readonly reason: 'token-unavailable' | 'refresh-checks' | null = null) { super(code); }
}
export type FinancialPolicyAttemptStatus = Readonly<{
  state: 'idle' | 'unavailable' | 'preparing' | 'unsent' | 'unknown' | 'recorded'; reference: FinancialPolicyReference | null;
}>;
type Entry = {
  request: FinancialPolicyWriteRequest; bootstrap: FinancialPolicyBootstrap; observation: FinancialPolicyObservation;
  generation: number; controller: AbortController; storage: FinancialPolicyStorage; now: () => number;
  preparation: ReturnType<FinancialPolicyPreparationVerifier['capture']>; assertion: () => void; preparationNow: () => number; expiresAt: number;
  attempt: FinancialPolicyAttempt | null; dispatched: boolean; phase: 'preparing' | 'unsent' | 'unknown' | 'recorded';
  stored: boolean; operation: { controller: AbortController; guard: () => void } | null;
};
const storageError = () => new FinancialPolicyClientError('storage');
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new FinancialPolicyClientError('unconfirmed')); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new FinancialPolicyClientError('unconfirmed')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Private scan: both SQL namespaces span more than the existing scope-filtered reminder list. */
function inventory(storage: FinancialPolicyStorage): FinancialPolicyReference[] {
  try {
    const count = storage.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > 4096) throw storageError();
    const keys: string[] = [], seen = new Set<string>(), rawValues = new Map<string, string>(), references: FinancialPolicyReference[] = [];
    for (let i = 0; i < count; i++) {
      const key = storage.key(i); if (key === null || seen.has(key)) throw storageError(); seen.add(key); keys.push(key);
      if (!key.startsWith(FINANCIAL_POLICY_REFERENCE_PREFIX)) continue;
      if (references.length >= FINANCIAL_POLICY_REFERENCE_LIMIT || new TextEncoder().encode(key).byteLength > FINANCIAL_POLICY_REFERENCE_MAX_BYTES)
        throw storageError();
      const raw = storage.getItem(key);
      if (raw === null || new TextEncoder().encode(raw).byteLength > FINANCIAL_POLICY_REFERENCE_MAX_BYTES) throw storageError();
      const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, JSON.parse(raw)));
      if (canonicalJson(reference) !== raw || financialPolicyReferenceKey(reference) !== key) throw storageError();
      rawValues.set(key, raw); references.push(reference);
    }
    // Recheck the whole bounded snapshot, including earlier entries changed without a length change.
    if (storage.length !== count) throw storageError();
    for (let i = 0; i < keys.length; i++) if (storage.key(i) !== keys[i]) throw storageError();
    for (const [key, raw] of rawValues) if (storage.getItem(key) !== raw) throw storageError();
    if (storage.length !== count) throw storageError();
    return references;
  } catch { throw storageError(); }
}
type ConflictIdentity = Pick<FinancialPolicyReference['scope'], 'environment' | 'organizationId' | 'actorId'> &
  Pick<FinancialPolicyReference['locator'], 'targetId' | 'kind' | 'key'>;
function originalIdentity(reference: FinancialPolicyReference): ConflictIdentity {
  const { environment, organizationId, actorId } = reference.scope, { targetId, kind, key } = reference.locator;
  return { environment, organizationId, actorId, targetId, kind, key };
}
function collision(a: ConflictIdentity, b: ConflictIdentity): boolean {
  if (a.environment !== b.environment || a.organizationId !== b.organizationId) return false;
  return a.targetId === b.targetId || a.actorId === b.actorId && a.kind === b.kind && a.key === b.key;
}
function reserved(entry: Entry): ConflictIdentity {
  const { environment, organizationId, actorId } = entry.bootstrap, { kind, key, id: targetId } = entry.request;
  return { environment, organizationId, actorId, targetId, kind, key };
}

/** Route-private mechanics only. A null preparation verifier makes every new save unavailable. */
export function createFinancialPolicyAttemptCoordinator(adapters: FinancialPolicyAttemptCoordinatorAdapters) {
  const { lifetime, memory, storage: storageSource, currentBootstrap, getToken, fetch: fetcher, preparation } = adapters;
  const wall = adapters.wall ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const suppliedWall = adapters.wall, suppliedMonotonic = adapters.monotonic, capture = preparation?.capture;
  const entries = new Set<Entry>(), gestures = new WeakMap<object, { entry: Entry; used: boolean }>();
  const leases = new WeakMap<object, { entry: Entry; used: boolean }>();
  let generation = 0, alive = true, active: Entry | null = null, last: Entry | null = null, invalidating = false;
  function invalidate() {
    if (invalidating) return;
    invalidating = true; generation++; const previous = [...entries]; entries.clear(); active = null; last = null;
    for (const entry of previous) { entry.controller.abort(); entry.operation?.controller.abort(); entry.attempt = null; }
    memory.clear(); invalidating = false;
  }
  const unlisten = lifetime.onInvalidate(invalidate);
  function ready() {
    if (!alive || invalidating) throw new FinancialPolicyClientError('scope');
    if (adapters.lifetime !== lifetime || adapters.memory !== memory || adapters.storage !== storageSource ||
      adapters.currentBootstrap !== currentBootstrap || adapters.getToken !== getToken || adapters.fetch !== fetcher ||
      adapters.preparation !== preparation || preparation?.capture !== capture || adapters.wall !== suppliedWall || adapters.monotonic !== suppliedMonotonic) {
      invalidate(); throw new FinancialPolicyClientError('scope');
    }
    try {
      const observation = lifetime.observation(), bootstrap = lifetime.bootstrap();
      if (!financialSame(currentBootstrap(), bootstrap) || getApiBase() !== bootstrap.apiBase) throw new FinancialPolicyClientError('scope');
      return { bootstrap, observation };
    } catch (error) { invalidate(); throw error instanceof FinancialPolicyClientError ? error : new FinancialPolicyClientError('scope'); }
  }
  function check(entry: Entry) {
    const current = ready();
    if (!entries.has(entry) || generation !== entry.generation || entry.controller.signal.aborted ||
      !financialSame(current.bootstrap, entry.bootstrap) || current.observation !== entry.observation)
      throw new FinancialPolicyClientError('scope');
    try { if (storageSource() !== entry.storage) throw storageError(); }
    catch { invalidate(); throw storageError(); }
    if (entry.preparation.assertCurrent !== entry.assertion || entry.preparation.now !== entry.preparationNow || entry.preparation.expiresAt !== entry.expiresAt ||
      entry.now() >= entry.expiresAt || entry.request.kind === 'save_draft' && Date.parse(entry.request.input.draft.expiresAt) <= entry.now())
      throw new FinancialPolicyClientError('expired');
    try { entry.assertion(); } catch { throw new FinancialPolicyClientError('expired'); }
  }
  function barrier(entry: Entry, ownStored: boolean) {
    const reference = reserved(entry);
    for (const other of entries) if (other !== entry && collision(reference, reserved(other))) throw storageError();
    for (const saved of inventory(entry.storage)) {
      if (collision(reference, originalIdentity(saved)) && !(ownStored && entry.attempt && financialSame(entry.attempt.reference, saved))) throw storageError();
    }
    if (ownStored) {
      if (!entry.attempt) throw storageError();
      assertFinancialPolicyReference(entry.storage, entry.attempt.reference);
    }
  }
  function assertionFor(request: FinancialPolicyWriteRequest, bootstrap: FinancialPolicyBootstrap, observation: FinancialPolicyObservation) {
    if (!preparation || !capture) throw new FinancialPolicyClientError('unavailable');
    try {
      const value = capture(freezeFinancial({ request, bootstrap, observation }));
      if (!value || typeof value.assertCurrent !== 'function' || typeof value.now !== 'function' || !Number.isFinite(value.expiresAt) ||
        value.expiresAt > observation.expiresAt || value.expiresAt <= wall()) throw new FinancialPolicyClientError('unavailable');
      value.assertCurrent(); const now = value.now();
      if (!Number.isFinite(now) || now < 0) throw new FinancialPolicyClientError('unavailable');
      return value;
    } catch { throw new FinancialPolicyClientError('unavailable'); }
  }
  function gesture(entry: Entry): FinancialPolicyWriteGesture {
    const token = Object.freeze({}) as FinancialPolicyWriteGesture; gestures.set(token, { entry, used: false }); active = entry; last = entry; return token;
  }
  function claim(lease: object, attempt: FinancialPolicyAttempt): FinancialPolicyWritePermit {
    const issued = leases.get(lease);
    if (!issued || issued.used || active !== issued.entry || !issued.entry.attempt || !financialSame(attempt, issued.entry.attempt))
      throw new FinancialPolicyClientError('scope');
    issued.used = true; const entry = issued.entry, operation = entry.operation;
    if (!operation) throw new FinancialPolicyClientError('scope');
    const guard = () => {
      operation.guard(); if (active !== entry || entry.operation !== operation) throw new FinancialPolicyClientError('scope');
      barrier(entry, true); operation.guard();
      if (active !== entry || entry.operation !== operation) throw new FinancialPolicyClientError('scope');
    };
    guard();
    return Object.freeze({ bootstrap: entry.bootstrap, observation: entry.observation, signal: operation.controller.signal,
      assertCurrent: guard,
      markDispatched() {
        guard(); if (entry.dispatched) throw new FinancialPolicyClientError('scope');
        entry.dispatched = true; entry.phase = 'unknown';
      },
      async settle(receipt: FinancialPolicyQualifiedReceipt, transportGuard: () => void) {
        const exact = entry.attempt;
        if (!exact || !entry.dispatched) throw new FinancialPolicyClientError('scope');
        const settlementGuard = () => { transportGuard(); guard(); if (entry.attempt !== exact) throw new FinancialPolicyClientError('scope'); };
        settlementGuard(); await memory.record(exact.reference, receipt, settlementGuard); settlementGuard(); entry.phase = 'recorded';
      },
    });
  }
  const transport = createFinancialPolicyWriteTransport({ lifetime, currentBootstrap, getToken, fetch: fetcher, claim,
    wall, monotonic });
  return {
    /** Call from a deliberate review/save gesture; request/key are supplied once, never generated on failure. */
    review(input: unknown): FinancialPolicyWriteGesture {
      const { bootstrap, observation } = ready();
      if (active || entries.size >= FINANCIAL_POLICY_REFERENCE_LIMIT) throw new FinancialPolicyClientError('scope');
      const request = parseFinancialPolicyWriteRequest(input);
      if (request.responsibilityId !== bootstrap.responsibilityId || request.input.organizationEpoch !== observation.context.scope.organizationEpoch ||
        request.kind === 'save_draft' && !financialSame(request.input.draft.scope, observation.context.draftScope))
        throw new FinancialPolicyClientError('scope');
      const asserted = assertionFor(request, bootstrap, observation); let storage: FinancialPolicyStorage | null;
      try { storage = storageSource(); } catch { throw storageError(); } if (!storage) throw storageError();
      const entry: Entry = { request, bootstrap, observation, generation, controller: new AbortController(), storage,
        now: createFinancialPolicyClock(observation.receivedAt, observation.receivedMonotonic, wall, monotonic), preparation: asserted, assertion: asserted.assertCurrent,
        preparationNow: asserted.now, expiresAt: asserted.expiresAt, attempt: null, dispatched: false, phase: 'preparing', stored: false, operation: null };
      // Reservation and conflict checks are synchronous, before hashing, provider waits or storage writes.
      entries.add(entry);
      try { check(entry); barrier(entry, false); check(entry); return gesture(entry); }
      catch (error) { entries.delete(entry); entry.controller.abort(); throw error instanceof FinancialPolicyClientError ? error : storageError(); }
    },
    async send(token: FinancialPolicyWriteGesture): Promise<Readonly<{ reference: FinancialPolicyReference; receipt: FinancialPolicyQualifiedReceipt }>> {
      const issued = gestures.get(token);
      if (!issued || issued.used || active !== issued.entry) throw new FinancialPolicyWriteAttemptError('scope', 'not-dispatched');
      issued.used = true; const entry = issued.entry;
      const controller = new AbortController(), abort = () => controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const start = wall(), now = createFinancialPolicyClock(start, monotonic(), wall, monotonic);
        const guard = () => {
          check(entry);
          if (controller.signal.aborted || now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw new FinancialPolicyClientError('unconfirmed');
        };
        entry.operation = { controller, guard }; entry.controller.signal.addEventListener('abort', abort, { once: true });
        if (entry.controller.signal.aborted) abort();
        timer = setTimeout(abort, FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS);
        guard();
        if (!entry.attempt) {
          const original = await interrupted(createFinancialPolicyAttempt(financialPolicyLocalScope(entry.bootstrap), entry.request), controller.signal); guard();
          entry.attempt = original; barrier(entry, false);
          await interrupted(memory.retain(original), controller.signal); guard(); barrier(entry, false);
          const deadline = Math.min(entry.observation.expiresAt, entry.expiresAt,
            entry.request.kind === 'save_draft' ? Date.parse(entry.request.input.draft.expiresAt) : Infinity);
          const preparedNow = entry.preparationNow();
          if (!Number.isFinite(preparedNow) || preparedNow < 0) throw new FinancialPolicyClientError('expired');
          if (deadline - Math.max(entry.now(), preparedNow) <= FINANCIAL_POLICY_INITIAL_SAVE_MARGIN_MS)
            throw new FinancialPolicyWriteAttemptError('unavailable', 'not-dispatched', 'refresh-checks');
          storeFinancialPolicyReference(entry.storage, original.reference);
          assertFinancialPolicyReference(entry.storage, original.reference);
          entry.stored = true; entry.phase = 'unsent';
        }
        guard(); barrier(entry, true);
        if (!entry.attempt || !financialSame(memory.original(entry.attempt.reference), entry.attempt)) throw new FinancialPolicyClientError('scope');
        const attempt = entry.attempt, lease = Object.freeze({}); leases.set(lease, { entry, used: false });
        const receipt = await transport.submit(attempt, lease); guard();
        if (entry.attempt !== attempt || entry.phase !== 'recorded') throw new FinancialPolicyClientError('unconfirmed');
        return freezeFinancial({ reference: attempt.reference, receipt });
      } catch (error) {
        if (entries.has(entry)) {
          if (entry.dispatched) entry.phase = 'unknown'; else if (entry.attempt) entry.phase = 'unsent';
          if (!entry.stored && (controller.signal.aborted || error instanceof FinancialPolicyWriteAttemptError && error.reason === 'refresh-checks')) invalidate();
          else { try { check(entry); } catch { invalidate(); } }
        }
        throw new FinancialPolicyWriteAttemptError(error instanceof FinancialPolicyClientError ? error.code : 'unconfirmed',
          entry.dispatched ? 'unknown' : 'not-dispatched', error instanceof FinancialPolicyWriteTokenError || error instanceof FinancialPolicyWriteAttemptError ? error.reason : null);
      } finally {
        clearTimeout(timer); entry.controller.signal.removeEventListener('abort', abort); controller.abort(); entry.operation = null;
        if (active === entry) active = null;
      }
    },
    /** Only this same live instance can prove an intact original never reached fetch. */
    continueUnsent(input: FinancialPolicyReference): FinancialPolicyWriteGesture {
      const { bootstrap, observation } = ready(); if (active) throw new FinancialPolicyClientError('scope');
      const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, input));
      const entry = [...entries].find(value => value.attempt && financialSame(value.attempt.reference, reference));
      if (!entry || entry.dispatched || entry.phase !== 'unsent' || !entry.attempt ||
        !financialSame(memory.original(reference), entry.attempt)) throw new FinancialPolicyClientError('unconfirmed');
      check(entry); barrier(entry, true);
      const asserted = assertionFor(entry.request, bootstrap, observation);
      entry.preparation = asserted; entry.assertion = asserted.assertCurrent; entry.preparationNow = asserted.now; entry.expiresAt = asserted.expiresAt;
      check(entry); return gesture(entry);
    },
    /** No network, mutation or settlement. The accepted GET lifetime still requires its own gesture. */
    recoveryReference(input: FinancialPolicyReference): FinancialPolicyReference {
      const { bootstrap } = ready(), reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, input));
      if (!financialSame(reference.scope, financialPolicyLocalScope(bootstrap))) throw new FinancialPolicyClientError('scope');
      let storage: FinancialPolicyStorage | null;
      try { storage = storageSource(); } catch { throw storageError(); } if (!storage) throw storageError();
      inventory(storage); assertFinancialPolicyReference(storage, reference); ready();
      try { if (storageSource() !== storage) throw storageError(); } catch { throw storageError(); }
      return reference;
    },
    status(): FinancialPolicyAttemptStatus {
      try { ready(); if (last) check(last); }
      catch { invalidate(); return Object.freeze({ state: 'unavailable', reference: null }); }
      return freezeFinancial({ state: last?.phase ?? 'idle', reference: last?.attempt?.reference ?? null });
    },
    // Native controllers must call this before edits/material reads; a GET start alone is not this hook.
    invalidateReview: invalidate,
    close() { alive = false; invalidate(); unlisten(); transport.dispose(); },
  };
}
export type FinancialPolicyAttemptCoordinator = ReturnType<typeof createFinancialPolicyAttemptCoordinator>;
