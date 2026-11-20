import type { z } from 'zod';
import type { NativeModelGateway, ReasoningRole } from './azure-gateway';
import { DelegatedInterrupted, interruptible, type DelegatedLease } from './delegated-lease';

/** Leave settlement time inside the host/task deadline; renewed authorization
 * may sustain a model call but can never extend either original deadline. */
export async function runDelegatedModel<T>(lease: DelegatedLease, gateway: NativeModelGateway, request: {
  role: ReasoningRole; instructions: string; input: string; schema: z.ZodType<T>; schemaName: string;
}, deadlineAt: number, now: () => number = Date.now) {
  lease.assertCurrent();
  const remaining = deadlineAt - now() - 3000;
  if (remaining < 1000) throw new DelegatedInterrupted();
  const controller = new AbortController(), cancel = () => controller.abort();
  lease.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, Math.min(90000, remaining));
  try {
    return await lease.read(() => interruptible(gateway.complete({ ...request, signal: controller.signal }), controller.signal));
  } finally { clearTimeout(timer); lease.signal.removeEventListener('abort', cancel); controller.abort(); }
}
