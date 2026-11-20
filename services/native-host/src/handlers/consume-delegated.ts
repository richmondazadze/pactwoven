import { nativeQueue } from '../queue.js';
import { invocationDeadline } from '../deadline.js';
import { NativeDeliveryRetry } from '../consume.js';
import { runDelegatedQueueMessage } from '../delegated-host-runtime.js';

// Separate private topic and callback. A v1 delivery must never be interpreted
// as delegated work; the runtime also validates the complete delivery shape.
export function POST(request: Request) {
  const deadlineAt = invocationDeadline(300_000);
  return nativeQueue.handleCallback<unknown>(async payload => { await runDelegatedQueueMessage(payload, deadlineAt); }, {
    visibilityTimeoutSeconds: 300,
    retry: error => ({ afterSeconds: error instanceof NativeDeliveryRetry ? error.afterSeconds : 30 }),
  })(request);
}
