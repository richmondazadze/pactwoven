import { FinancialPolicyOriginalClosureRequestSchema, FinancialPolicyOriginalClosureResponseSchema,
  FinancialPolicyOriginalStatusResponseSchema, financialPolicyOriginalClosureRoute,
  type FinancialPolicyOriginalClosureRequest, type FinancialPolicyOriginalStatusResponse } from '@pactwoven/contracts';
import { getApiBase } from './config';
import { FinancialPolicyClientError, FinancialPolicyReferenceSchema, financialParse, financialSame, freezeFinancial,
  matchFinancialScope, qualifyFinancialRecovery, type FinancialPolicyReference } from './financial-policy-contract';
import { createFinancialPolicyClock, financialPolicyLocalScope, type FinancialPolicyObservation } from './financial-policy-context';
import { assertFinancialPolicyReference, type FinancialPolicyStorage } from './financial-policy-recovery';
import { FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS, readFinancialPolicyResponseJson, type FinancialPolicyTransportAdapters } from './financial-policy-transport';

export type FinancialPolicyClosureReview = Readonly<{ reference: FinancialPolicyReference;
  request: FinancialPolicyOriginalClosureRequest; expiresAt: number }>;
export class FinancialPolicyClosureAttemptError extends FinancialPolicyClientError {
  constructor(code: FinancialPolicyClientError['code'], readonly outcome: 'not-dispatched' | 'unknown') { super(code); }
}
type Fact = { reference: FinancialPolicyReference; observation: FinancialPolicyObservation; expiresAt: number; now: () => number };
type Review = { fact: Fact; value: FinancialPolicyClosureReview; storage: FinancialPolicyStorage; used: boolean; generation: number };
const unavailable = () => new FinancialPolicyClientError('unavailable');
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new FinancialPolicyClientError('unconfirmed')); }
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener('abort', abort);
    const abort = () => { clean(); reject(new FinancialPolicyClientError('unconfirmed')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
  });
}

/** A negative lookup permits review, never settlement. Each closure needs its own one-shot deliberate gesture. */
export function createFinancialPolicyClosureClient(adapters: FinancialPolicyTransportAdapters) {
  const { lifetime, memory, storage, currentBootstrap, getToken, fetch: fetcher } = adapters;
  const wall = adapters.wall ?? Date.now, monotonic = adapters.monotonic ?? (() => performance.now());
  const suppliedWall = adapters.wall, suppliedMonotonic = adapters.monotonic;
  let alive = true, generation = 0, fact: Fact | null = null, selected: Review | null = null, active: AbortController | null = null;
  const reviews = new WeakMap<object, Review>();
  function invalidate() { generation++; fact = null; selected = null; active?.abort(); }
  const unlisten = lifetime.onInvalidate(invalidate);
  function current() {
    if (!alive || adapters.lifetime !== lifetime || adapters.memory !== memory || adapters.storage !== storage ||
      adapters.currentBootstrap !== currentBootstrap || adapters.getToken !== getToken || adapters.fetch !== fetcher ||
      adapters.wall !== suppliedWall || adapters.monotonic !== suppliedMonotonic) throw new FinancialPolicyClientError('scope');
    const observation = lifetime.observation(), bootstrap = lifetime.bootstrap();
    if (!financialSame(currentBootstrap(), bootstrap) || getApiBase() !== bootstrap.apiBase) throw new FinancialPolicyClientError('scope');
    return { observation, bootstrap };
  }
  function checked(input: FinancialPolicyReference) {
    const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, input)), context = current();
    if (!financialSame(reference.scope, financialPolicyLocalScope(context.bootstrap))) throw new FinancialPolicyClientError('scope');
    if (!['save_document', 'save_draft'].includes(reference.locator.kind) ||
      reference.scope.responsibilityId === null && !context.observation.context.scope.roles.includes('owner')) throw unavailable();
    if (!fact || fact.observation !== context.observation || !financialSame(fact.reference, reference) || fact.now() >= fact.expiresAt ||
      memory.original(reference) || memory.recorded(reference) || memory.closed(reference)) throw unavailable();
    return { ...context, fact, reference };
  }
  return {
    /** Call only after the current explicit GET has been qualified by the read transport. */
    noteLookup(input: FinancialPolicyReference, responseInput: FinancialPolicyOriginalStatusResponse) {
      invalidate();
      const reference = freezeFinancial(financialParse(FinancialPolicyReferenceSchema, input)), { observation, bootstrap } = current();
      const response = freezeFinancial(financialParse(FinancialPolicyOriginalStatusResponseSchema, responseInput));
      matchFinancialScope(response.scope, observation.context.scope);
      if (!financialSame(reference.scope, financialPolicyLocalScope(bootstrap)) || !financialSame(reference.locator, {
        responsibilityId: response.responsibilityId, kind: response.kind, key: response.key, targetId: response.targetId,
        publicRequestHash: response.publicRequestHash })) throw new FinancialPolicyClientError('scope');
      if (response.status !== 'not_recorded') return;
      const now = createFinancialPolicyClock(observation.receivedAt, observation.receivedMonotonic, wall, monotonic);
      const expiresAt = Math.min(observation.expiresAt, Date.parse(response.observation.expiresAt));
      if (Date.parse(response.observation.observedAt) > now() || now() >= expiresAt) throw new FinancialPolicyClientError('expired');
      fact = { reference, observation, expiresAt, now };
    },
    canReview(input: FinancialPolicyReference) { try { if (active) return false; checked(input); return true; } catch { return false; } },
    review(input: FinancialPolicyReference): FinancialPolicyClosureReview {
      if (active) throw unavailable();
      const context = checked(input), scope = context.observation.context.scope;
      let targetStorage: FinancialPolicyStorage | null;
      try { targetStorage = storage(); } catch { throw new FinancialPolicyClientError('storage'); }
      if (!targetStorage) throw new FinancialPolicyClientError('storage');
      assertFinancialPolicyReference(targetStorage, context.reference);
      const request = freezeFinancial(financialParse(FinancialPolicyOriginalClosureRequestSchema, { schemaVersion: 1,
        purpose: 'financial_policy_original_close', reason: 'original_input_unavailable', locator: context.reference.locator,
        expected: { environment: scope.environment, organizationId: scope.organizationId, actor: scope.actor,
          organizationEpoch: scope.organizationEpoch, draftScope: context.observation.context.draftScope } }));
      const value = freezeFinancial({ reference: context.reference, request, expiresAt: context.fact.expiresAt });
      selected = { value, fact: context.fact, storage: targetStorage, used: false, generation }; reviews.set(value, selected); return value;
    },
    reviewCurrent(value: FinancialPolicyClosureReview) {
      try { const issued = reviews.get(value); return !active && issued === selected && issued?.generation === generation && !issued.used && checked(value.reference).fact === issued.fact; }
      catch { return false; }
    },
    cancelReview() { selected = null; },
    async submit(value: FinancialPolicyClosureReview): Promise<FinancialPolicyOriginalStatusResponse> {
      const issued = reviews.get(value);
      if (!issued || issued !== selected || issued.used || issued.generation !== generation || active) throw unavailable();
      const { bootstrap, observation } = checked(value.reference);
      const start = wall(), now = createFinancialPolicyClock(start, monotonic(), wall, monotonic); issued.used = true;
      const controller = new AbortController(), signal = controller.signal, deadline = {}; active = controller;
      const timer = setTimeout(() => controller.abort(deadline), FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS);
      let dispatched = false, response: Response | undefined, responseDeadline = Infinity;
      const guard = () => {
        const owner = current();
        if (active !== controller || issued !== selected || issued.generation !== generation || owner.observation !== observation ||
          !financialSame(owner.bootstrap, bootstrap) || fact !== issued.fact) throw new FinancialPolicyClientError('scope');
        if (signal.aborted || now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw new FinancialPolicyClientError('unconfirmed');
        if (issued.fact.now() >= Math.min(issued.fact.expiresAt, responseDeadline)) throw new FinancialPolicyClientError('expired');
        if (storage() !== issued.storage) throw new FinancialPolicyClientError('storage');
        assertFinancialPolicyReference(issued.storage, value.reference);
        const afterStorage = current();
        if (active !== controller || selected !== issued || issued.generation !== generation || fact !== issued.fact ||
          afterStorage.observation !== observation || !financialSame(afterStorage.bootstrap, bootstrap)) throw new FinancialPolicyClientError('scope');
        if (signal.aborted || now() >= start + FINANCIAL_POLICY_TRANSPORT_DEADLINE_MS) throw new FinancialPolicyClientError('unconfirmed');
        if (issued.fact.now() >= Math.min(issued.fact.expiresAt, responseDeadline)) throw new FinancialPolicyClientError('expired');
        if (!dispatched && (memory.original(value.reference) || memory.recorded(value.reference) || memory.closed(value.reference))) throw unavailable();
      };
      try {
        guard();
        const token = await interrupted(getToken({ organizationId: bootstrap.externalOrganizationId, skipCache: true }), signal); guard();
        if (!token || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        const url = bootstrap.apiBase + financialPolicyOriginalClosureRoute(value.request.locator);
        const init: RequestInit = { method: 'POST', body: JSON.stringify(value.request), cache: 'no-store', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`, 'Idempotency-Key': value.request.locator.key } };
        guard(); dispatched = true;
        const received = await interrupted(Promise.resolve(fetcher(url, init)).then(result => {
          if (signal.aborted) { void result.body?.cancel().catch(() => {}); throw new FinancialPolicyClientError('unconfirmed'); } return result;
        }), signal); response = received; guard();
        if (received.status === 401 || received.status === 403) { lifetime.deny(); throw new FinancialPolicyClientError('scope'); }
        if (received.redirected || received.url && received.url !== url || received.status < 200 || received.status >= 300 && received.status < 400)
          throw new FinancialPolicyClientError('unconfirmed');
        const raw = await readFinancialPolicyResponseJson(received, signal, guard); guard();
        if (!received.ok) throw new FinancialPolicyClientError('unconfirmed');
        const parsed = financialParse(FinancialPolicyOriginalClosureResponseSchema, raw);
        responseDeadline = Date.parse(parsed.observation.expiresAt);
        if (Date.parse(parsed.observation.observedAt) > Math.max(now(), issued.fact.now())) throw new FinancialPolicyClientError('expired');
        guard();
        // A committed original/closure can outlive the submitted mutable pins.
        // Correlate stable identity and exact locator; controllers retire a changed local context separately.
        const result = await interrupted(qualifyFinancialRecovery(parsed, parsed.scope, value.reference), signal); guard();
        if (result.receipt) await interrupted(memory.record(value.reference, result.receipt, guard), signal);
        else if (result.closure) await interrupted(memory.recordClosure(value.reference, result.closure, guard), signal);
        else throw new FinancialPolicyClientError('unconfirmed');
        guard(); return result;
      } catch (error) {
        void response?.body?.cancel().catch(() => {});
        const code = signal.reason === deadline ? 'unconfirmed' : error instanceof FinancialPolicyClientError ? error.code : 'unconfirmed';
        throw new FinancialPolicyClosureAttemptError(dispatched && !['scope', 'expired'].includes(code) ? 'unconfirmed' : code,
          dispatched ? 'unknown' : 'not-dispatched');
      } finally {
        clearTimeout(timer); controller.abort(); if (active === controller) active = null;
        if (selected === issued) { selected = null; fact = null; generation++; }
      }
    },
    invalidateReview: invalidate,
    close() { alive = false; invalidate(); unlisten(); },
  };
}
