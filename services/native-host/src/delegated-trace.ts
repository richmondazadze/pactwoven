import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import type { NativeModelGateway, ModelRequest, ModelResult } from '../../coordinator/src/azure-gateway';
import type { DelegatedAuthorityObserver } from '../../coordinator/src/delegated-lease';
import type { DelegatedQueueMessage } from './delegated-dispatch';

type Context = { invocationId: string; workDigest: string };
type Event = 'execution_started' | 'execution_settled' | 'execution_discarded' | 'execution_retry'
  | 'authority_allowed' | 'authority_denied' | 'authority_unavailable'
  | 'model_started' | 'model_resolved' | 'model_aborted' | 'model_failed';
const context = new AsyncLocalStorage<Context>();

/** Diagnostic correlation only: no prompt, source text, user ID or credential.
 * Database receipts remain authoritative; missing logs never prove no effect.
 */
export function delegatedTraceFields(): Partial<Context> { return { ...context.getStore() }; }
function emitFor(active: Context | undefined, event: Event, usableUntil?: number | null) {
  if (!active) return;
  try {
    console.info(JSON.stringify({ kind: 'delegated-execution-trace', ...active, event, at: new Date().toISOString(),
      ...(typeof usableUntil === 'number' && Number.isSafeInteger(usableUntil) ? { usableUntil } : {}) }));
  } catch { /* Telemetry failure cannot change an operation outcome. */ }
}
const emit = (event: Event, usableUntil?: number | null) => emitFor(context.getStore(), event, usableUntil);
export async function withDelegatedTrace(message: DelegatedQueueMessage, run: () => Promise<'discarded' | 'settled'>) {
  const workDigest = await commandDigest({ namespace: 'pactwoven/delegated-trace/v1', environment: message.environment,
    kind: message.kind, target: message.target });
  return context.run({ invocationId: randomUUID(), workDigest }, async () => {
    emit('execution_started');
    try { const result = await run(); emit(result === 'settled' ? 'execution_settled' : 'execution_discarded'); return result; }
    catch (error) { emit('execution_retry'); throw error; }
  });
}
export function traceDelegatedAuthority(observe: DelegatedAuthorityObserver): DelegatedAuthorityObserver {
  return async (target, options) => {
    try {
      const result = await observe(target, options);
      emit(result.result.state === 'allowed' ? 'authority_allowed' : result.result.state === 'denied' ? 'authority_denied' : 'authority_unavailable', result.usableUntil);
      return result;
    } catch (error) { emit('authority_unavailable'); throw error; }
  };
}
export function traceDelegatedGateway(gateway: NativeModelGateway): NativeModelGateway {
  return { async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    let aborted = false;
    // AbortSignal listeners execute in the abort caller's context; retain the
    // originating invocation so another concurrent delivery cannot relabel it.
    const origin = context.getStore();
    const record = (event: Event) => emitFor(origin, event);
    const abort = () => { if (!aborted) { aborted = true; record('model_aborted'); } };
    record('model_started'); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    try { const result = await gateway.complete(request); if (!aborted) record('model_resolved'); return result; }
    catch (error) { if (!aborted) record('model_failed'); throw error; }
    finally { request.signal.removeEventListener('abort', abort); }
  } };
}
